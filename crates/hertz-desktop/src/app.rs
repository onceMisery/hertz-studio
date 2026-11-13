// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词宿主：窗口、托盘、来源线程与可见性策略。

use std::borrow::Cow;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget};
use tao::platform::windows::{
    EventLoopBuilderExtWindows, WindowBuilderExtWindows, WindowExtWindows,
};
use tao::window::{Window, WindowBuilder};
use tray_icon::menu::{CheckMenuItem, ContextMenu, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE,
};
use wry::http::{header, Request, Response};
use wry::{WebContext, WebViewBuilder, WebViewExtWindows};

use crate::config::{self, Config, Layout, LyricAlign, LyricsConfig, Profile, Secondary};
use crate::feed::{Document, Feed, Snapshot};
use crate::mini::{MiniAction, MiniEvent, MiniHost, MiniPhase};
use crate::mini_feed::MiniUpdate;
use crate::mini_native::{self, DragEvent};
use crate::native::{self, NativeEvent};
use crate::native_events::{self, EventLoopProxy};
use crate::wallpaper::policy;
use crate::wallpaper_feed::{
    Feed as WallpaperFeed, FeedError, Snapshot as WallpaperSnapshot, ERR_EVENTS_UNAVAILABLE,
};

#[path = "feature_exit.rs"]
mod feature_exit;

#[path = "lyrics_settings.rs"]
mod lyrics_settings;

#[path = "settings_presentation.rs"]
mod settings_presentation;
#[path = "wallpaper_ai.rs"]
mod wallpaper_ai;
#[path = "wallpaper_apply.rs"]
mod wallpaper_apply;
#[path = "wallpaper_audio.rs"]
mod wallpaper_audio;
#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[path = "wallpaper_close_probe.rs"]
mod wallpaper_close_probe;
#[path = "wallpaper_desktop.rs"]
mod wallpaper_desktop;
#[path = "wallpaper_handoff.rs"]
mod wallpaper_handoff;
#[path = "wallpaper_mirror.rs"]
mod wallpaper_mirror;
#[path = "wallpaper_playlist.rs"]
mod wallpaper_playlist;
#[path = "wallpaper_pointer.rs"]
mod wallpaper_pointer;
#[path = "wallpaper_preview.rs"]
mod wallpaper_preview;
#[path = "wallpaper_runtime.rs"]
mod wallpaper_runtime;

const POLL_IDLE: Duration = Duration::from_millis(500);
const POLL_ERROR: Duration = Duration::from_secs(1);
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);
use crate::management::STALE_AFTER;
const PREVIEW_LEASE: Duration = Duration::from_secs(15);
/// 页面每 2 s 心跳；可见状态下超过这个时间没有有效心跳就按渲染停摆重建。
const HEARTBEAT_STALE: Duration = Duration::from_secs(10);

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) enum UserEvent {
    Dbx(u64, Box<crate::dbx_feed::Message>),
    Feed(
        u64,
        Arc<AtomicBool>,
        Instant,
        Box<Result<crate::feed::FeedUpdate, String>>,
    ),
    WallpaperFeed(
        u64,
        Arc<AtomicBool>,
        Instant,
        Box<Result<WallpaperSnapshot, FeedError>>,
    ),
    WallpaperPage(u64, String),
    WallpaperAudio,
    WallpaperAudioDelivered(usize, u64),
    WallpaperMirrorClock(u64, Instant, Instant, Option<f64>),
    WallpaperApplyLayouts(u64, Result<(), crate::wallpaper::jobs::JobError>),
    WallpaperSelection(
        u64,
        Result<
            Box<crate::wallpaper::selection_plan::ResolvedPlan>,
            crate::wallpaper::selection_plan::Failure,
        >,
    ),
    MediaPreviewSelection(
        u64,
        Result<
            Box<crate::wallpaper::selection_plan::ResolvedPlan>,
            crate::wallpaper::jobs::JobError,
        >,
    ),
    WallpaperMedia(u64, Box<crate::wallpaper::webresource::PreparedResponse>),
    WallpaperProbe(Box<crate::wallpaper::decode_probe::ProbeRequest>),
    WallpaperProbePage(u64, String),
    WallpaperProbeEnvironment(tokio::sync::oneshot::Sender<Option<String>>),
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    WallpaperProbeTestResult(u64, serde_json::Value),
    SettingsPage(u64, String),
    WallpaperAiResult(
        u64,
        crate::wallpaper::api::Request,
        Box<Result<crate::wallpaper::ai::Catalog, crate::wallpaper::jobs::JobError>>,
    ),
    WallpaperManagement(ApiReply, serde_json::Value),
    WorkPreviewReady(
        crate::wallpaper::api::Request,
        u64,
        u64,
        ApiReply,
        Box<Result<crate::wallpaper::work_drafts::Document, crate::wallpaper::jobs::JobError>>,
    ),
    PlaylistWriteFinished(Option<String>),
    LibraryDeleteFinished(String),
    /// 小窗快照轮询的一拍（含可能的封面字节）。
    MiniFeed(u64, Instant, Box<Result<MiniUpdate, String>>),
    /// 呈现时钟的 4Hz 位置推进。
    MiniPosition(u64, u64),
    /// 拖拽线程的光标事件。
    MiniDrag(u64, DragEvent),
    /// 小窗页面的 IPC 消息。
    MiniPage(String),
    /// 小窗播控/回主窗口的结果（只记日志与提示）。
    MiniControl(u64, Result<(), String>),
    MiniRestore(u64, Arc<AtomicBool>, Result<(), String>),
    Tick,
    Page(String),
    LyricControl(u64, Result<(), String>),
    LyricCalibration(u64, String, serde_json::Value),
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    Native(NativeEvent),
    Pipe(crate::pipe::PipeRequest),
    /// 播放器进程内直接下发的命令/菜单动作：同一个分派函数，零进程、零管道。
    Host(crate::host::HostAction),
    Quit,
    FeatureIdleExit,
}

#[derive(Clone)]
pub(crate) enum ApiReply {
    Settings(u64),
    Pipe(
        std::sync::mpsc::SyncSender<serde_json::Value>,
        hertz_desktop_ipc::management::Admission,
    ),
    /// 进程内命令的应答（没有传输层准入，不需要 Admission）。
    Host(mpsc::SyncSender<serde_json::Value>),
}

/// 播放器进程内宿主与独立 exe 共用的运行参数。
pub(crate) struct RunConfig {
    pub(crate) args: Args,
    /// true = 由播放器持有窗口与生命周期（跳过单实例互斥与管理管道）。
    pub(crate) embedded: bool,
    /// true = 宿主自己创建托盘；播放器已有托盘时为 false。
    pub(crate) host_tray: bool,
    pub(crate) commands: Option<crate::host::CommandReceiver>,
    pub(crate) ready: Option<crate::host::ReadySender>,
    pub(crate) settings_events: Option<crate::settings_embedding::SettingsEvents>,
}

/// 初始化失败也要给 `start_embedded` 一个明确回执，不能让它干等超时。
struct ReadyGuard(Option<crate::host::ReadySender>);
impl ReadyGuard {
    fn new(ready: Option<crate::host::ReadySender>) -> Self {
        Self(ready)
    }
    fn ok(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(Ok(()));
        }
    }
}
impl Drop for ReadyGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(Err("桌面宿主初始化失败".into()));
        }
    }
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
        !(self.user_hidden
            || self.fullscreen
            || self.session_unavailable
            || self.display_off
            || self.locked && self.no_content)
    }
}

/// One-way page-ready mapping. The upstream IPC delay is counted as extra age,
/// so queue delay is conservative even across wall-clock adjustments.
#[derive(Clone, Copy)]
struct PageClock {
    native_ready: Instant,
    page_ready_ms: f64,
}
impl PageClock {
    fn new(page_ready_ms: f64) -> Option<Self> {
        (page_ready_ms.is_finite() && page_ready_ms >= 0.0).then(|| Self {
            native_ready: Instant::now(),
            page_ready_ms,
        })
    }
    fn at(self, now: Instant) -> f64 {
        self.page_ready_ms
            + now
                .saturating_duration_since(self.native_ready)
                .as_secs_f64()
                * 1000.0
    }
}

enum PresentationWindow {
    Desktop { candidate: bool },
    Preview { owner: HWND, embedded: bool },
}

struct WallpaperSurface {
    page_clock: Option<PageClock>,
    pointer: wallpaper_pointer::Input,
    // Destroy the controller before its parent HWND.
    webview: wry::WebView,
    _web_context: WebContext,
    window: Window,
    session: crate::wallpaper::session::WallpaperSession,
    binding: crate::wallpaper::page_events::PageBinding,
    created_at: Instant,
    frame_wait_since: Option<Instant>,
    static_poster: bool,
    configuration: config::WallpaperConfig,
    runtime_builtin: Option<crate::wallpaper::config::BuiltinState>,
    runtime_reference: Option<crate::wallpaper::playlist::FixedVersion>,
    playlist_token: Option<u64>,
    mirror_source_generation: Option<u64>,
    monitor: native::WallpaperMonitor,
    zoom: f64,
    eval_failures: AtomicU64,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    close_probe_blocked: bool,
    _media_access: crate::wallpaper::access::MediaAccess,
}

struct RetiringWallpaper {
    generation: u64,
    // Keep package references until both controller and file-reader exit barriers complete.
    configuration: config::WallpaperConfig,
    runtime_reference: Option<crate::wallpaper::playlist::FixedVersion>,
    surface: Option<WallpaperSurface>,
    session: Option<crate::wallpaper::session::WallpaperSession>,
    drain: crate::wallpaper::access::Drain,
    close_attempts: u64,
    close_error: Option<i32>,
    close_failed_since: Option<Instant>,
    last_close_ms: u64,
}

impl RetiringWallpaper {
    fn new(mut surface: WallpaperSurface) -> Self {
        surface.stop();
        surface.session.disable();
        let drain = surface._media_access.revoke();
        Self {
            generation: surface.binding.generation(),
            configuration: surface.configuration.clone(),
            runtime_reference: surface.runtime_reference.clone(),
            surface: Some(surface),
            session: None,
            drain,
            close_attempts: 0,
            close_error: None,
            close_failed_since: None,
            last_close_ms: 0,
        }
    }

    fn poll(&mut self) -> bool {
        if let Some(surface) = self.surface.as_ref() {
            self.close_attempts = self.close_attempts.saturating_add(1);
            let started = Instant::now();
            let result = surface.close_controller();
            self.last_close_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if let Err(error) = result {
                if self.close_error != Some(error) {
                    log(&format!(
                        "wallpaper controller close pending generation={} HRESULT=0x{:08X}",
                        self.generation, error as u32
                    ));
                }
                self.close_error = Some(error);
                self.close_failed_since.get_or_insert_with(Instant::now);
                return false;
            }
            self.close_error = None;
            self.close_failed_since = None;
            let WallpaperSurface {
                mut session,
                webview,
                _web_context: web_context,
                window,
                ..
            } = self.surface.take().expect("closing surface");
            drop(webview);
            drop(web_context);
            drop(window);
            for generation in session.retiring_generations() {
                session.controller_closed(generation);
            }
            self.session = Some(session);
        }
        let Some(session) = self.session.as_mut() else {
            return false;
        };
        session.reap_resources();
        self.drain.is_drained() && session.retiring_generations().is_empty()
    }

    fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({
            "generation": self.generation,
            "sessionId": self.surface.as_ref().map(|surface| surface.binding.session_id()),
            "controllerClosed": self.surface.is_none(),
            "fileReadersDrained": self.drain.is_drained(),
            "closeAttempts": self.close_attempts,
            "closeError": self.close_error.map(|error| format!("0x{:08X}", error as u32)),
            "closeFailedAgeMs": self.close_failed_since.map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
            "lastCloseMs": self.last_close_ms,
        })
    }
}

impl WallpaperSurface {
    fn close_controller(&self) -> std::result::Result<(), i32> {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.close_probe_blocked {
            // Explicit debug-only failure injection; never an exit confirmation.
            return Err(0x80004005_u32 as i32);
        }
        unsafe { self.webview.controller().Close() }.map_err(|error| error.code().0)
    }

    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }

    fn media_frame_kind(&self) -> crate::wallpaper::session::FrameKind {
        use crate::wallpaper::{media::Container, session::FrameKind};
        self.session.media().map_or(FrameKind::Gl, |media| {
            if media.input().metadata.container == Container::Image {
                FrameKind::Image
            } else {
                FrameKind::Video
            }
        })
    }

    fn load_media_page(&mut self) {
        self.apply_config(&self.configuration, self.monitor.refresh_hz);
        if let Some(media) = self.session.media() {
            let kind = if self.media_frame_kind() == crate::wallpaper::session::FrameKind::Image {
                "image"
            } else {
                "video"
            };
            let descriptor = serde_json::json!({"kind":kind,"url":media.url(),"fit":self.configuration.presentation().fit,
                "resumePositionMs":self.session.media_position_ms().unwrap_or(0),
                "groupClock":kind == "video" && self.configuration.main().mode == crate::wallpaper::config::LayoutMode::Mirror});
            self.eval(&format!("window.hertzWallpaper.applyMedia({descriptor});"));
        }
        if let Some(url) = self.session.gl().and_then(|gl| gl.composition_url()) {
            let url = serde_json::to_string(url).expect("native composition URL");
            self.eval(&format!("window.hertzWallpaper.applyComposition({url});"));
        }
        self.start(self.configuration.presentation().fps);
        self.frame_wait_since = Some(Instant::now());
    }

    fn first_frame_ready(&self) -> bool {
        use crate::wallpaper::session::SessionState;
        matches!(
            self.session.state(),
            SessionState::Ready | SessionState::Running | SessionState::Paused
        )
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
        if let Ok(payload) = wallpaper_payload(snapshot, self.page_clock) {
            self.eval(&format!(
                "window.hertzWallpaper && window.hertzWallpaper.applyFeed({payload});"
            ));
        }
    }

    fn apply_config(&self, wallpaper: &config::WallpaperConfig, refresh_hz: u32) {
        let mut configuration = wallpaper_page_config(wallpaper, refresh_hz);
        // Feed still carries audio/position. Native owns scene changes so every
        // new scene passes capture, Close and fresh admission.
        if let Some(state) = &self.runtime_builtin {
            configuration["source"] = "fixed".into();
            configuration["scene"] = state.scene_id.clone().into();
            configuration["params"] = serde_json::json!(state.params);
        }
        if let Some(gl) = self.session.gl() {
            configuration["quality"] = gl.limits.quality.clone().into();
            configuration["refreshHz"] = gl.limits.refresh_hz.into();
        }
        if self.static_poster {
            configuration["pointer"] = false.into();
            configuration["motion"] = 0.into();
        }
        if let Ok(payload) = serde_json::to_string(&configuration) {
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
        if !self.session.clear_media_pause(Instant::now()) {
            return;
        }
        self.set_visible(true);
        let fps = self
            .session
            .gl()
            .map_or(u32::from(fps), |gl| u32::from(fps).min(gl.limits.fps));
        self.eval(&format!(
            "window.hertzWallpaper && window.hertzWallpaper.start({fps});"
        ));
    }

    fn stop(&self) {
        self.pause_keep_visible();
        self.set_visible(false);
    }

    fn pause_keep_visible(&self) {
        let token = serde_json::to_string(&self.session.request_media_pause(Instant::now()))
            .expect("pause token");
        self.eval(&format!(
            "window.hertzWallpaper && window.hertzWallpaper.stop({token});"
        ));
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
    // Drop the controller before its HWND.
    webview: Rc<wry::WebView>,
    window: Window,
    _web_context: WebContext,
    placement: Option<crate::settings_embedding::SettingsPlacement>,
    preview_bounds: Option<crate::settings_embedding::SettingsBounds>,
    ready: bool,
}

impl SettingsSurface {
    fn eval(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
            log(&format!("settings evaluate_script failed: {error}"));
        }
    }
}

struct PositionEdit {
    session_stopped: bool,
    exit_save_failed: bool,
    lyrics: config::LyricsConfig,
    user_hidden: bool,
    owner: Option<lyrics_settings::PositionOwner>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyWallpaperCandidate {
    enabled: bool,
    fps: u8,
    music_response: bool,
    #[serde(default)]
    monitor: Option<String>,
    #[serde(default)]
    display_id: Option<String>,
    #[serde(default = "config::default_wallpaper_source")]
    source: String,
    #[serde(default = "config::default_wallpaper_scene")]
    scene: String,
    #[serde(default = "config::default_wallpaper_brightness")]
    brightness: f64,
    #[serde(default = "config::default_wallpaper_motion")]
    motion: f64,
    #[serde(default)]
    quality: config::WallpaperQuality,
    #[serde(default)]
    #[allow(dead_code)] // v4 只收 pause；runLow 属 P1 的显式用户选项
    battery_policy: config::BatteryPolicy,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum WallpaperCandidate {
    Current(config::WallpaperConfig),
    Legacy(LegacyWallpaperCandidate),
}
impl WallpaperCandidate {
    fn normalized(&self) -> Result<config::WallpaperConfig, String> {
        let mut config = match self {
            Self::Current(config) => config.clone(),
            Self::Legacy(legacy) => config::LegacyWallpaperConfig {
                enabled: legacy.enabled,
                fps: legacy.fps,
                music_response: legacy.music_response,
                monitor: legacy.monitor.clone(),
                display_id: legacy.display_id.clone(),
                source: legacy.source.clone(),
                scene: legacy.scene.clone(),
                brightness: legacy.brightness,
                motion: legacy.motion,
                battery_policy: legacy.battery_policy,
                quality: legacy.quality,
            }
            .migrate(&native::wallpaper_monitors(), false)
            .map_err(|error| error.to_string())?,
        };
        config.normalize().map_err(|error| error.to_string())?;
        validate_current_presentation(&config)?;
        Ok(config)
    }
}

fn validate_current_presentation(config: &config::WallpaperConfig) -> Result<(), String> {
    if config.groups.iter().any(|group| {
        !matches!(
            group.selection,
            crate::wallpaper::config::Selection::Builtin { .. }
                | crate::wallpaper::config::Selection::FollowHertz { .. }
        )
    }) {
        return Err("请使用本地作品的正式应用入口".into());
    }
    validate_configured_presentation(config)
}

fn validate_configured_presentation(config: &config::WallpaperConfig) -> Result<(), String> {
    use crate::wallpaper::config::LayoutMode;
    crate::wallpaper::display::requested_target_count(&config.groups)
        .map_err(|error| error.to_string())?;
    if config.groups.iter().any(|group| {
        group.mode == LayoutMode::Mirror
            && matches!(
                group.selection,
                crate::wallpaper::config::Selection::Builtin { .. }
                    | crate::wallpaper::config::Selection::FollowHertz { .. }
            )
    }) {
        return Err("内置场景依赖历史状态，镜像请选择图片或视频作品".into());
    }
    if config.builtin().is_none()
        && !matches!(
            config.main().selection,
            crate::wallpaper::config::Selection::Package { .. }
                | crate::wallpaper::config::Selection::Playlist { .. }
        )
    {
        return Err("此作品类型暂时无法应用".into());
    }
    if config.groups.iter().any(|group| {
        !group.properties.is_empty()
            && !matches!(
                group.selection,
                crate::wallpaper::config::Selection::Package { .. }
                    | crate::wallpaper::config::Selection::Playlist { .. }
            )
    }) {
        return Err("公开属性覆盖需要固定作品版本或轮播列表".into());
    }
    Ok(())
}

fn wallpaper_page_config(
    wallpaper: &config::WallpaperConfig,
    refresh_hz: u32,
) -> serde_json::Value {
    let builtin = wallpaper.builtin();
    serde_json::json!({
        "source": if wallpaper.follows_hertz() { "follow" } else { "fixed" },
        "scene": builtin.as_ref().map(|state| state.scene_id.as_str()),
        "params": builtin.as_ref().map(|state| &state.params),
        "musicResponse": !matches!(wallpaper.audio_input, crate::wallpaper::config::AudioInput::None),
        "audioInput": wallpaper.audio_input,
        "allowed": config::WALLPAPER_SCENES.iter().map(|(id,_)| *id).collect::<Vec<_>>(),
        "brightness": wallpaper.presentation().brightness,"motion":wallpaper.presentation().motion,
        "pointer": wallpaper.presentation().pointer,
        "quality": wallpaper.presentation().quality.as_str(),"refreshHz":refresh_hz,
    })
}

struct TrayActions {
    toggle: CheckMenuItem,
    autostart: CheckMenuItem,
    wallpaper_toggle: Option<CheckMenuItem>,
    mini_toggle: CheckMenuItem,
    lyrics_exit: MenuItem,
    wallpaper_exit: MenuItem,
    toggle_id: String,
    locate_id: String,
    autostart_id: String,
    settings_id: String,
    wallpaper_toggle_id: Option<String>,
    wallpaper_retry_id: Option<String>,
    mini_toggle_id: String,
    mini_assets_id: String,
    lyrics_exit_id: String,
    wallpaper_exit_id: String,
    quit_id: String,
}

/// 小窗的原生 surface。窗口与 WebView 一起生灭；封面走共享槽（协议闭包读最新帧，
/// 事件循环写它），避免每次换封面都 base64。
type MiniCover = Arc<std::sync::Mutex<Option<(u64, Vec<u8>, String)>>>;

struct MiniSurface {
    window: Window,
    webview: wry::WebView,
    _web_context: WebContext,
    hwnd: HWND,
}

struct App {
    desktop: wallpaper_runtime::DesktopTargets,
    wallpaper_apply: Option<wallpaper_apply::ApplyTransaction>,
    playlist_writes: usize,
    window: Window,
    webview: wry::WebView,
    _web_context: WebContext,
    tray: Option<TrayIcon>,
    tray_actions: Option<TrayActions>,
    /// 由播放器进程直接持有（不启动外部 exe、不开管理管道）。
    embedded: bool,
    /// 本宿主是否拥有自己的托盘；播放器已有托盘时菜单归播放器管。
    host_tray: bool,
    config: Config,
    committed_config: Config,
    /// 全局恢复快捷键注册事务（§5.1）；None 仅在事务执行瞬间出现。
    hotkey: Option<crate::hotkey::Manager>,
    dbx: Option<crate::dbx_feed::Controller>,
    dbx_session: Option<String>,
    source_health: crate::management::SourceHealth,
    wallpaper_last_update: Option<Instant>,
    wallpaper_audio: crate::wallpaper::audio_service::AudioService,
    wallpaper_audio_dispatch: wallpaper_audio::Dispatch,
    profile: Profile,
    policy: Policy,
    last_snapshot: Option<Snapshot>,
    calibration_pending: Option<crate::calibration::Pending>,
    last_update: Instant,
    current_track: Option<String>,
    current_document_key: Option<String>,
    current_document: Option<Document>,
    page_ready: bool,
    page_clock: Option<PageClock>,
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
    wallpaper_retiring: Vec<RetiringWallpaper>,
    wallpaper_handoff_retiring: Vec<wallpaper_handoff::Handoff>,
    wallpaper_probe: crate::wallpaper::decode_probe::ProbeHost,
    wallpaper_last: Option<WallpaperSnapshot>,
    wallpaper_feed_logged: bool,
    wallpaper_hidden: bool,
    wallpaper_forced: bool,
    feature_stops: feature_exit::FeatureStops,
    last_topology_check: Instant,
    wallpaper_power: native::PowerState,
    source_generation: u64,
    lyrics_feed_stop: Arc<AtomicBool>,
    wallpaper_feed_stop: Option<Arc<AtomicBool>>,
    wallpaper_generation: u64,
    wallpaper_library: crate::wallpaper::service::LibraryService,
    /// 正在执行的删除请求 id；期间拒绝会新增版本引用的设置变更。
    library_delete: Option<String>,
    settings_drafts: crate::wallpaper::settings_drafts::SettingsDrafts,
    wallpaper_ai: crate::wallpaper::ai::NativeAi,
    settings_generation: u64,
    settings: Option<SettingsSurface>,
    settings_events: Option<crate::settings_embedding::SettingsEvents>,
    settings_candidate: Option<Profile>,
    settings_tab: String,
    settings_navigation: u64,
    preview: Option<wallpaper_preview::PreviewOwner>,
    work_preview_epoch: u64,
    /// 配置格式迁移的一次性说明（schema v4）。
    migration_notice: Option<String>,
    position_edit: Option<PositionEdit>,
    placed_position: Option<(i32, i32)>,
    /// 页面样式条高度（DIP）；展开时窗口向下长高，歌词区域保持原高度。
    panel_height: f64,
    /// 样式条展开期间的窗口顶边（物理像素），关掉面板后回到锚点定位。
    panel_top: Option<i32>,
    /// 页面按当前这句歌词量出的窗口宽度（DIP）；0.0 表示还没上报，先用设定宽度。
    lyrics_fit_width: f64,
    lyrics_measured_slot: f64,
    lyrics_measure_font: Option<String>,
    lyrics_geometry_payload: RefCell<Option<String>>,
    /// Full work-area identity from the native placement owner, sampled by the existing one-second tick.
    lyrics_placed_area: Option<native::WorkArea>,
    /// 小窗播放（桌面宠物）：窗口按需创建，状态机常驻。
    mini: Option<MiniSurface>,
    mini_page_ready: bool,
    mini_host: MiniHost,
    mini_last_snapshot: Option<crate::mini_feed::MiniSnapshot>,
    mini_feed_logged: bool,
    mini_drag_offset: Option<(i32, i32)>,
    /// 小窗封面版本号：协议闭包按版本号回图，页面用 ?v= 破缓存。
    mini_cover_version: u64,
    mini_cover: MiniCover,
    /// 桌宠素材目录的签名（文件名+大小+mtime 哈希）。变化即触发热重载。
    mini_skin_signature: Option<u64>,
    mini_runtime: MiniRuntime,
    mini_context_menu: Option<Menu>,
    mini_restore_pending: Option<MiniRestoreRequest>,
    proxy: EventLoopProxy<UserEvent>,
}

/// 小窗来源线程与事件循环之间的共享开关。
#[derive(Clone, Default)]
struct MiniRuntime {
    stop: Arc<AtomicBool>,
    /// 小窗可见（非 Hidden）：暂停时位置推送与轮询节奏都看它。
    visible: Arc<AtomicBool>,
    /// 轮询间隔提示（毫秒）。组件侧按相位/播放态更新，线程每拍读取。
    poll_hint_ms: Arc<AtomicU64>,
}

struct MiniRestoreRequest {
    started: Instant,
    cancelled: Arc<AtomicBool>,
    ready: bool,
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
        let mut payload = serde_json::to_value(lyrics).unwrap();
        payload["frameCap"] = self.frame_cap.into();
        let panel_max = self
            .target_area()
            .map(|area| {
                (f64::from(area.height()) / area.scale() - self.base_height_dip() - 16.0)
                    .clamp(120.0, 480.0)
            })
            .unwrap_or(360.0);
        payload["panelMaxHeight"] = serde_json::json!(panel_max);
        payload["vocalGeometry"] = self.lyrics_geometry_value();
        if self.page_ready {
            *self.lyrics_geometry_payload.borrow_mut() = Some(payload["vocalGeometry"].to_string());
        }
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applyConfig({payload});"
        ));
    }

    fn send_source(&self) {
        let payload = serde_json::json!({
            "state": self.source_state,
            "message": self.source_message,
            "capabilities": { "lyricsControl": !config::is_dbx(&self.profile) },
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
        let mut payload = serde_json::to_value(snapshot).unwrap();
        let now = Instant::now();
        payload["snapshotAgeMs"] =
            (now.saturating_duration_since(self.last_update).as_millis() as u64).into();
        if let Some(clock) = self.page_clock {
            payload["pageDispatchMs"] = serde_json::json!(clock.at(now));
        }
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applySnapshot({payload});"
        ));
    }

    fn send_document(&self) {
        self.send_lyrics_geometry();
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

    fn handle_update(&mut self, mut update: crate::feed::FeedUpdate, started: Instant) {
        if started.elapsed() >= STALE_AFTER {
            return;
        }
        if self.current_document.is_some()
            && self
                .last_snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.server.session == update.snapshot.server.session)
            && self.current_document_key == update.snapshot.lyrics.document_key
            && self.current_track.as_deref()
                == update
                    .snapshot
                    .track
                    .as_ref()
                    .map(|track| track.id.as_str())
        {
            update.document = None;
        }
        self.source_health
            .accept(true, started, &update.snapshot.server.session);
        self.handle_timed_update(update, started);
    }

    fn handle_timed_update(&mut self, update: crate::feed::FeedUpdate, started: Instant) {
        if self
            .calibration_pending
            .as_ref()
            .is_some_and(|p| !p.matches(&update.snapshot))
        {
            self.cancel_calibration();
        }
        if !self.lyrics_needed() {
            return;
        }
        self.last_update = started;
        self.last_feed_error = None;
        let track_id = update.snapshot.track.as_ref().map(|track| track.id.clone());
        let track_changed = track_id != self.current_track;
        let session_changed = self
            .last_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.server.session != update.snapshot.server.session);
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
        if session_changed || track_changed || incoming_key != self.current_document_key {
            self.current_document = None;
            self.current_document_key = incoming_key.clone();
            document_changed = true;
        }
        if let Some(document) = update.document {
            self.current_document_key = document.document_key.clone().or(snapshot_key);
            self.current_document = Some(document);
            document_changed = true;
        }
        if update.snapshot.lyrics.status != "ready" && self.current_document.take().is_some() {
            self.current_document_key = update.snapshot.lyrics.document_key.clone();
            document_changed = true;
        }
        self.policy.no_content = update.snapshot.track.is_none()
            || update.snapshot.lyrics.status != "ready"
            || self.current_document.is_none()
            || (self.vocal_document_mode()
                && self.config.lyrics.show_vocals
                && self.lyrics_vocal_geometry().capacity == 0);
        let source_message = match update.snapshot.lyrics.status.as_str() {
            "unsupported" => Some(crate::feed::DocumentError::Unsupported.message().to_owned()),
            "invalid" => Some(crate::feed::DocumentError::Invalid.message().to_owned()),
            _ => None,
        };
        if self.source_state != "ok" || self.source_message != source_message {
            self.source_state = "ok";
            self.source_message = source_message;
            self.send_source();
        }
        // 先快照后文档：页面用新快照的 documentKey 校验文档，顺序反了会把同一拍
        // 刚取回的文档当成旧文档丢掉。
        self.last_snapshot = Some(update.snapshot);
        self.send_snapshot();
        if document_changed {
            self.place(true);
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
        self.cancel_calibration();
        self.source_health.fail(true);
        if self.last_feed_error.as_deref() != Some(&message) {
            log(&format!("source error: {message}"));
            self.last_feed_error = Some(message.clone());
        }
        let waiting =
            message.contains("未找到") || message.contains("未启动") || message.contains("等待");
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

    fn handle_document_failure(&mut self, error: crate::feed::DocumentError) {
        if let Some(snapshot) = self.last_snapshot.as_mut() {
            snapshot.lyrics.status = error.status().into();
        }
        self.current_document = None;
        self.policy.no_content = true;
        self.source_state = "ok";
        self.source_message = Some(error.message().into());
        self.send_snapshot();
        self.send_document();
        self.send_source();
        self.place(true);
        self.recompute_visibility();
    }

    fn reset_wallpaper_heartbeat(&mut self) {
        self.desktop.heartbeat_at = None;
        self.desktop.fps_sample = None;
        self.desktop.measured_fps = None;
    }

    fn reset_wallpaper_page_stats(&mut self) {
        self.desktop.heartbeat_ticks = 0;
        self.desktop.heartbeat_draws = 0;
        self.reset_wallpaper_heartbeat();
    }

    fn sample_wallpaper_fps(&mut self, now: Instant, draws: u64) {
        let Some((at, last)) = self.desktop.fps_sample else {
            self.desktop.fps_sample = Some((now, draws));
            return;
        };
        if draws < last {
            self.desktop.fps_sample = Some((now, draws));
            self.desktop.measured_fps = None;
            return;
        }
        if let Some(fps) = fps_from_draws(draws - last, now.duration_since(at)) {
            self.desktop.measured_fps = Some(fps);
            self.desktop.fps_sample = Some((now, draws));
        }
    }

    fn recompute_visibility(&mut self) {
        let visible = self.lyrics_running() && self.policy.visible();
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
        self.for_each_desktop(|app| app.recompute_wallpaper_target());
    }

    fn recompute_wallpaper_target(&mut self) {
        self.sync_wallpaper_handoff_visibility();
        let global_ready = !self
            .desktop
            .recovery
            .is_terminal(crate::wallpaper::session::FaultDomain::Global);
        let mirror_failed = self
            .desktop
            .mirrors
            .get(&self.desktop.configuration.main().id)
            .is_some_and(|group| group.playback.is_failed());
        let wallpaper_enabled = self.wallpaper_target_running(&self.desktop.configuration);
        let desktop = &mut *self.desktop;
        let Some(surface) = desktop.surface.as_mut() else {
            return;
        };
        if !native::wallpaper_alive(surface.hwnd()) {
            return;
        }
        use crate::wallpaper::session::PauseScope;
        let now = Instant::now();
        if desktop.monitor_missing {
            surface.session.add_pause_reason(
                policy::REASON_DISPLAY_MISSING,
                PauseScope::DesktopOnly,
                now,
            );
            // waitingDisplay：宽限期已过、目标屏确认缺失；保留 surface，仅停绘。
            surface.stop();
            surface.frame_wait_since = None;
            desktop.visible = false;
            return;
        }
        surface.session.remove_pause_reason(
            policy::REASON_DISPLAY_MISSING,
            PauseScope::DesktopOnly,
            now,
        );
        // 页面就绪前不能把 WebView2 隐藏：隐藏会让页面不加载，dom_ready 永远不来。
        if !desktop.page_ready {
            return;
        }
        let inputs = policy::PolicyInputs {
            enabled: global_ready && wallpaper_enabled,
            wallpaper: &desktop.configuration,
            manual_pause: self.wallpaper_hidden,
            fullscreen: desktop.fullscreen_gate.stable(),
            maximized: desktop.maximized_gate.stable(),
            application_rule: desktop.application_gate.stable(),
            session_unavailable: self.policy.session_unavailable,
            display_off: self.policy.display_off,
            display_missing: desktop.monitor_missing,
            power: self.wallpaper_power,
            has_surface: true,
            page_ready: desktop.page_ready,
        };
        let reasons = policy::pause_reasons(&inputs);
        for (name, scope) in [
            (policy::REASON_MANUAL_PAUSE, PauseScope::DesktopOnly),
            (policy::REASON_FULLSCREEN, PauseScope::DesktopOnly),
            (policy::REASON_MAXIMIZED, PauseScope::DesktopOnly),
            (policy::REASON_APPLICATION_RULE, PauseScope::DesktopOnly),
            (
                policy::REASON_SESSION_UNAVAILABLE,
                PauseScope::AllPresentations,
            ),
            (policy::REASON_DISPLAY_OFF, PauseScope::AllPresentations),
            (policy::REASON_BATTERY, PauseScope::AllPresentations),
        ] {
            if reasons.contains(&name) {
                surface.session.add_pause_reason(name, scope, now);
            } else {
                surface.session.remove_pause_reason(name, scope, now);
            }
        }
        let visible = inputs.enabled
            && surface.configuration.presentation().fps > 0
            && !inputs.manual_pause
            && policy::renderable(&inputs);
        let retain_frame =
            global_ready && policy::retain_frame(&inputs) && surface.first_frame_ready();
        let was_visible = desktop.visible;
        desktop.visible = visible && surface.first_frame_ready();
        if visible && mirror_failed && !surface.static_poster {
            surface.set_visible(true);
            surface.pause_keep_visible();
            return;
        }
        if visible {
            if surface.first_frame_ready() {
                surface.frame_wait_since = None;
            } else {
                surface.frame_wait_since.get_or_insert_with(Instant::now);
            }
            surface.start(surface.configuration.presentation().fps);
            if surface.first_frame_ready() {
                surface.eval("window.hertzWallpaper && window.hertzWallpaper.reveal();");
            }
            // 只在重新变为可见时给宽限；feed 每 250 ms 调本函数，不能把心跳
            // 时间一直刷新，否则页面停摆永远不会被判超时。
            if desktop.visible && !was_visible {
                desktop.heartbeat_at = Some(Instant::now());
                desktop.fps_sample = Some((Instant::now(), desktop.heartbeat_draws));
                desktop.measured_fps = None;
            }
        } else {
            surface.frame_wait_since = None;
            if retain_frame {
                surface.set_visible(true);
                surface.pause_keep_visible();
            } else {
                surface.stop();
            }
            if surface.configuration.main().mode == crate::wallpaper::config::LayoutMode::Mirror
                && surface.media_frame_kind() == crate::wallpaper::session::FrameKind::Video
            {
                desktop.mirror_presented = None;
            }
            if was_visible {
                self.reset_wallpaper_heartbeat();
            }
        }
    }

    /// 拓扑/全屏/预览策略的 250 ms 巡检（设计 §13.1/§13.2）：
    /// 空拓扑宽限不销毁；目标缺失连续 3 次才判 displayMissing；全屏走非对称去抖。
    fn poll_wallpaper_policy(&mut self, target: &EventLoopWindowTarget<()>) {
        let now = Instant::now();
        if now.duration_since(self.last_topology_check) < policy::TOPOLOGY_INTERVAL {
            return;
        }
        self.last_topology_check = now;
        let monitors = native::wallpaper_monitors();
        if let Err(error) = self.reconcile_desktops(&monitors, now) {
            log(&format!("wallpaper topology: {error}"));
        }
        let foreground = native::wallpaper_foreground();
        self.for_each_desktop(|app| {
            app.poll_desktop_policy(target, now, &monitors, foreground.as_ref())
        });
    }

    fn poll_desktop_policy(
        &mut self,
        target: &EventLoopWindowTarget<()>,
        now: Instant,
        monitors: &[native::WallpaperMonitor],
        foreground: Option<&native::WallpaperForeground>,
    ) {
        if monitors.is_empty() {
            // 空拓扑宽限：模式切换/驱动重置/RDP 可能短暂少报，不销毁、不累计缺失。
            return;
        }
        // Keep sampling after Stop has released every window. Foreground facts
        // are shared, but each target gets only its selected monitors' policy.
        let members = self
            .desktop
            .target
            .as_ref()
            .map(|target| {
                target
                    .members
                    .iter()
                    .map(|member| member.monitor())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let state = native::wallpaper_window_state(foreground, &members);
        let application = policy::application_rule(&self.desktop.configuration, state.executable);
        let fullscreen_changed = self
            .desktop
            .fullscreen_gate
            .update(state.fullscreen, now)
            .is_some();
        let maximized_changed = self
            .desktop
            .maximized_gate
            .update(state.maximized, now)
            .is_some();
        let application_changed = self
            .desktop
            .application_gate
            .update(application, now)
            .is_some();
        if fullscreen_changed || maximized_changed || application_changed {
            self.recompute_wallpaper();
        }
        if let Some(monitor) = self
            .desktop
            .target
            .as_ref()
            .filter(|target| !target.retained)
            .map(|target| target.monitor())
        {
            self.reconcile_wallpaper_handoff_geometry(&monitor);
            self.reconcile_wallpaper_geometry(target, monitor);
        }
    }

    /// 目标屏仍在拓扑中时的几何/DPI 校准（原 1 s 节奏并入 250 ms 巡检）。
    fn reconcile_wallpaper_geometry(
        &mut self,
        target: &EventLoopWindowTarget<()>,
        monitor: native::WallpaperMonitor,
    ) {
        let (geometry_changed, zoom_changed) = {
            let Some(surface) = self.desktop.surface.as_ref() else {
                return;
            };
            let window_dpi = native::window_dpi(surface.hwnd()).max(1);
            let zoom_changed =
                (f64::from(monitor.dpi) / f64::from(window_dpi) - surface.zoom).abs() > 0.001;
            (
                monitor_geometry_changed(&surface.monitor, &monitor),
                zoom_changed,
            )
        };
        if !geometry_changed && !zoom_changed {
            return;
        }
        if geometry_changed
            && self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.session.media().is_some())
        {
            if self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.static_poster)
            {
                self.retain_static_wallpaper_poster();
                self.retire_wallpaper_surface();
                self.desktop.page_ready = false;
                self.desktop.visible = false;
                return;
            }
            self.retain_wallpaper_playback();
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.desktop.failed_revision = None;
            if let Err(error) = self.ensure_media_wallpaper(target) {
                self.desktop.apply_error = Some(error.to_string());
            }
            return;
        }
        if geometry_changed {
            if self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.session.gl().is_some())
            {
                self.retire_wallpaper_surface();
                self.desktop.page_ready = false;
                self.desktop.visible = false;
                let result = if self.desktop.configuration.builtin().is_some() {
                    self.stage_builtin_wallpaper(target)
                } else {
                    self.ensure_media_wallpaper(target)
                };
                if let Err(error) = result {
                    self.desktop.apply_error = Some(error.to_string());
                }
                return;
            }
            log(&format!(
                "wallpaper monitor geometry changed name={} rect={},{} {}x{} dpi={} hz={}",
                monitor.name,
                monitor.left,
                monitor.top,
                monitor.width,
                monitor.height,
                monitor.dpi,
                monitor.refresh_hz
            ));
            let Some(surface) = self.desktop.surface.as_mut() else {
                return;
            };
            if let Err(error) = surface.reflow(monitor) {
                log(&format!("wallpaper reflow failed: {error:#}"));
                self.retire_wallpaper_surface();
                self.desktop.page_ready = false;
                self.desktop.visible = false;
                self.reset_wallpaper_page_stats();
                self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
                self.recover_wallpaper(target);
                return;
            }
        } else if let Some(surface) = self.desktop.surface.as_mut() {
            if let Err(error) = surface.apply_zoom(monitor.dpi) {
                log(&format!("wallpaper zoom sync failed: {error:#}"));
            }
        }
        self.recompute_wallpaper();
    }

    fn handle_wallpaper_feed(&mut self, result: Result<WallpaperSnapshot, FeedError>) {
        if self.feature_stops.wallpaper {
            return;
        }
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
                for desktop in self.desktop.runtimes.values() {
                    if let Some(surface) = desktop.surface.as_ref().filter(|_| desktop.page_ready) {
                        surface.apply_feed(&snapshot);
                    }
                }
                if let Some(preview) = self.preview_surface() {
                    if preview.first_frame_ready() {
                        preview.apply_feed(&snapshot);
                    }
                }
            }
            Err(error) => {
                self.source_health.fail(false);
                log(&format!("wallpaper feed {error}"));
                self.wallpaper_feed_logged = false;
                self.wallpaper_last = None;
                for desktop in self.desktop.runtimes.values() {
                    if let Some(surface) = desktop.surface.as_ref() {
                        surface.clear_feed();
                    }
                }
                if let Some(preview) = self.preview_surface() {
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
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.handle_wallpaper_close_probe(generation, event) {
            return;
        }
        if (event.starts_with(crate::wallpaper::handoff::CAPTURE_PREFIX)
            && self.handle_preview_capture(generation, event))
            || self.handle_preview_page(generation, event)
        {
            return;
        }
        if let Some(key) = self.desktop.route_generation(generation) {
            self.with_desktop(&key, |app| app.handle_desktop_page(generation, event));
        }
    }

    fn handle_desktop_page(&mut self, generation: u64, event: &str) {
        if self.handle_wallpaper_capture(generation, event) {
            return;
        }
        // A final pause receipt can arrive while its controller is retiring. It may
        // update only the saved checkpoint for that exact old binding, until consumed.
        let desired_revision = self.desktop.desired_revision;
        if let Some(resume) = self.desktop.playback.as_mut() {
            if resume.observe(desired_revision, generation, event) {
                return;
            }
        }
        if self.handle_candidate_page(generation, event) {
            return;
        }
        if self
            .desktop
            .surface
            .as_ref()
            .is_none_or(|surface| surface.binding.generation() != generation)
        {
            log(&format!(
                "ignore stale wallpaper page generation={generation} current={}",
                self.wallpaper_generation
            ));
            return;
        }
        if (event.starts_with("wallpaper_gl_failed ")
            || event.starts_with("wallpaper_media_failed ")
            || event == "wallpaper_mount_failed")
            && self.is_mirror_target()
            && self.desktop.surface.as_ref().is_some_and(|surface| {
                !self.mirror_surface_matches(surface) && !surface.static_poster
            })
        {
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            return;
        }
        if event.starts_with("wallpaper_gl_failed ") {
            self.desktop.apply_error = Some(event.chars().take(256).collect());
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
            self.desktop.recovery_terminal = true;
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.reset_wallpaper_page_stats();
            self.send_settings_status(self.desktop.apply_error.as_deref(), None);
            return;
        }
        if event.starts_with("wallpaper_media_failed ")
            && self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.session.media().is_some())
        {
            self.fail_mirror_target();
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
            self.desktop.apply_error = Some(event.chars().take(256).collect());
            self.prepare_failed_wallpaper_poster();
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.reset_wallpaper_page_stats();
            self.send_settings_status(self.desktop.apply_error.as_deref(), None);
            return;
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if let Some(body) = event.strip_prefix("wallpaper_probe_import ") {
            if body.len() <= 4096 {
                crate::wallpaper::decode_probe::harness::command(body, self.proxy.clone());
            }
            return;
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if let Some(body) = event.strip_prefix("wallpaper_probe_access ") {
            // 显式测试构建专用。正式构建不存在此分支，网页无法自授准入。
            if body.len() <= 32768 {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct ProbeAccess {
                    nonce: u64,
                    generation: u64,
                    resources: Vec<(String, String)>,
                }
                if let (Some(surface), Ok(request)) = (
                    self.desktop.surface.as_ref(),
                    serde_json::from_str::<ProbeAccess>(body),
                ) {
                    let accepted = surface
                        ._media_access
                        .replace(request.generation, &request.resources);
                    surface.eval(&format!(
                        "window.__nativeMediaProbe={};",
                        serde_json::json!({
                            "nonce": request.nonce, "accepted": accepted,
                            "activeStreams": crate::wallpaper::media_stream::global_pool().active(),
                        })
                    ));
                }
            }
            return;
        }
        if let Some(clock) = parse_page_clock(event) {
            if let Some(surface) = self.desktop.surface.as_mut() {
                surface.page_clock = Some(clock);
            }
            return;
        }
        if let Some((ticks, draws, mounted, lost)) = parse_wallpaper_heartbeat(event) {
            if mounted && !lost {
                let now = Instant::now();
                self.desktop.heartbeat_at = Some(now);
                self.desktop.heartbeat_ticks = ticks;
                self.desktop.heartbeat_draws = draws;
                self.sample_wallpaper_fps(now, draws);
            }
            return;
        }
        if event.starts_with("wallpaper_session ") {
            use crate::wallpaper::page_events::PageEvent;
            use crate::wallpaper::session::FrameKind;
            let desktop = &mut *self.desktop;
            let Some(surface) = desktop.surface.as_mut() else {
                return;
            };
            match surface.binding.parse(event) {
                Some(PageEvent::Revealed) => {
                    if self
                        .desktop
                        .surface
                        .as_ref()
                        .is_some_and(|surface| surface.static_poster)
                    {
                        self.finish_wallpaper_handoff(generation);
                        return;
                    }
                    if self.is_mirror_target()
                        && self
                            .desktop
                            .surface
                            .as_ref()
                            .is_some_and(|surface| surface.media_frame_kind() == FrameKind::Video)
                    {
                        return;
                    }
                    if !self.mirror_presented(generation) {
                        return;
                    }
                    self.finish_wallpaper_handoff(generation);
                    return;
                }
                Some(PageEvent::MediaClockRevealed(token)) => {
                    if !self.is_mirror_target() || self.desktop.mirror_clock_token != token {
                        return;
                    }
                    if self.mirror_presented(generation) {
                        self.finish_wallpaper_handoff(generation);
                    }
                    return;
                }
                Some(PageEvent::Handshake) => {
                    if !surface.session.page_handshake(generation) {
                        return;
                    }
                    log("wallpaper page handshake");
                    desktop.page_ready = true;
                    let now = Instant::now();
                    desktop.heartbeat_ticks = 0;
                    desktop.heartbeat_draws = 0;
                    desktop.heartbeat_at = Some(now);
                    desktop.fps_sample = Some((now, 0));
                    desktop.measured_fps = None;
                    surface.reset_eval_failures();
                    surface.session.start_presentation(Instant::now());
                }
                // This controller currently hosts builtins. A media receipt cannot qualify GL.
                Some(PageEvent::FirstFrame(FrameKind::Gl)) => {
                    if !surface.session.frame_submitted(generation, FrameKind::Gl) {
                        return;
                    }
                    surface.session.start_presentation(Instant::now());
                    log("wallpaper page mounted: current session submitted first GL frame");
                    self.recompute_wallpaper();
                    return;
                }
                Some(PageEvent::MediaPosition(position)) => {
                    surface.session.record_media_position(generation, position);
                    return;
                }
                Some(PageEvent::MediaPaused(token)) => {
                    surface
                        .session
                        .confirm_media_pause(generation, token, Instant::now());
                    return;
                }
                _ => return,
            }
        } else {
            match event {
                // Kept for the embedded builtin preview and legacy diagnostics only.
                "wallpaper_dom_ready" | "wallpaper_ready" => return,
                "wallpaper_mount_failed" => {
                    log("wallpaper page mount failed");
                    if let Some(surface) = self.desktop.surface.as_mut() {
                        surface.session.fail(
                            generation,
                            "scene_mount_failed",
                            "场景无法挂载",
                            true,
                        );
                    }
                    self.desktop.page_ready = false;
                    self.reset_wallpaper_page_stats();
                }
                other => log(&format!("unknown wallpaper page event: {other}")),
            }
        }
        if self.desktop.page_ready {
            if let Some(surface) = self.desktop.surface.as_ref() {
                surface.apply_config(&surface.configuration, surface.monitor.refresh_hz);
            }
            if let Some(snapshot) = self.wallpaper_last.as_ref() {
                if let Some(surface) = self.desktop.surface.as_ref() {
                    surface.apply_feed(snapshot);
                }
            }
        }
        self.recompute_wallpaper();
    }

    fn recover_wallpaper(&mut self, target: &EventLoopWindowTarget<()>) {
        self.for_each_desktop(|app| app.recover_wallpaper_target(target));
    }

    fn recover_wallpaper_target(&mut self, target: &EventLoopWindowTarget<()>) {
        // Policy-driven teardown is not a rendering fault and cannot consume
        // the bounded recovery attempts while the policy still blocks drawing.
        if !self.wallpaper_render_allowed() || self.desktop.policy_released {
            return;
        }
        if self.desktop.handoff.is_some()
            || self.desktop.candidate.is_some()
            || self.desktop.prepared.is_some()
        {
            return;
        }
        if self.desktop.failed_revision == Some(self.desktop.desired_revision) {
            return;
        }
        self.poll_wallpaper_retirements();
        if !self.wallpaper_retiring.is_empty() {
            return;
        }
        if !self.wallpaper_target_running(&self.desktop.configuration) {
            return;
        }
        if self
            .desktop
            .surface
            .as_ref()
            .is_some_and(|surface| native::wallpaper_alive(surface.hwnd()))
        {
            return;
        }
        if self.desktop.configuration.builtin().is_none() {
            if let Err(error) = self.ensure_media_wallpaper(target) {
                self.desktop.apply_error = Some(error.to_string());
            }
            return;
        }
        if let Err(error) = validate_current_presentation(&self.desktop.configuration) {
            self.desktop.apply_error = Some(error);
            return;
        }
        // 缺屏不是渲染故障，不消耗重建预算，也不临时认领另一块屏。
        if self.desktop_monitor().is_none() {
            self.desktop.monitor_missing = true;
            return;
        }
        let now = Instant::now();
        self.desktop
            .recovery_attempts
            .retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(120));
        if self.desktop.recovery_terminal {
            log("wallpaper recovery terminal; waiting for explicit retry");
            return;
        }
        if self.desktop.recovery_attempts.len() >= 3 {
            self.desktop.recovery_terminal = true;
            log("wallpaper recovery terminal attempts>=3 window=120s");
            self.send_settings_status(Some("壁纸挂载失败，请从托盘重新挂载"), None);
            return;
        }
        self.desktop.recovery_attempts.push(now);
        let attempt = self.desktop.recovery_attempts.len();
        log(&format!("wallpaper recovery begin attempt={attempt}"));
        self.retire_wallpaper_surface();
        if !self.wallpaper_retiring.is_empty() {
            return;
        }
        self.desktop.page_ready = false;
        self.desktop.visible = false;
        self.reset_wallpaper_page_stats();
        self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
        match self.stage_builtin_wallpaper(target) {
            Ok(()) => {
                self.desktop.monitor_missing = false;
                self.desktop.apply_error = None;
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

    fn retry_wallpaper(&mut self, target: &EventLoopWindowTarget<()>) {
        if self.feature_stops.wallpaper {
            return;
        }
        self.desktop.recovery.explicit_retry(
            crate::wallpaper::session::FaultDomain::Global,
            Instant::now(),
        );
        let failed: Vec<_> = self
            .desktop
            .mirrors
            .iter()
            .filter(|(_, group)| group.playback.is_failed())
            .map(|(id, _)| id.clone())
            .collect();
        for id in failed {
            let _ = self.mirror_next(&id, true);
        }
        self.for_each_desktop(|app| app.retry_wallpaper_target(target));
    }

    fn retry_wallpaper_target(&mut self, target: &EventLoopWindowTarget<()>) {
        self.desktop.failed_revision = None;
        self.desktop.recovery_terminal = false;
        if self.wallpaper_audio.snapshot().phase == "failed" {
            self.wallpaper_audio.retry();
        }
        if self.desktop.configuration.builtin().is_none() {
            self.retry_media_wallpaper(target);
            return;
        }
        if let Some(dbx) = &self.dbx {
            dbx.retry();
        }
        log("wallpaper retry requested");
        self.desktop.recovery_terminal = false;
        self.desktop.recovery_attempts.clear();
        if self.desktop.handoff.is_some() || self.desktop.surface.is_some() {
            self.cancel_wallpaper_transition();
            if let Err(error) = self.stage_builtin_wallpaper(target) {
                self.desktop.apply_error = Some(error.to_string());
            }
        } else {
            self.recover_wallpaper(target);
        }
    }

    fn current_wallpaper_candidate(&self) -> WallpaperCandidate {
        WallpaperCandidate::Current(self.config.wallpaper.clone())
    }

    /// 已保存偏好与真实注册状态分别上报（§5.1：不用配置值冒充已生效）。
    fn recovery_hotkey_json(&self) -> serde_json::Value {
        let saved = self.config.recovery_hotkey.clone();
        let (registered, error) = match self.hotkey.as_ref() {
            Some(manager) => {
                let status = manager.status(saved.as_ref());
                (
                    serde_json::Value::Array(
                        status
                            .registered
                            .iter()
                            .map(|shortcut| serde_json::Value::String(shortcut.as_str().to_owned()))
                            .collect(),
                    ),
                    status.error.clone().map(serde_json::Value::String),
                )
            }
            None => (serde_json::Value::Array(Vec::new()), None),
        };
        serde_json::json!({
            "saved": saved.as_ref().map(|shortcut| shortcut.as_str()),
            "registered": registered,
            "error": error,
        })
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
                    "displayId": monitor.display_id(),
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
            "config": self.config.wallpaper,
            "scenes": config::WALLPAPER_SCENES
                .iter()
                .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
                .collect::<Vec<_>>(),
            "spaceScene": self
                .wallpaper_last
                .as_ref()
                .and_then(|snapshot| snapshot.space.as_ref())
                .map(|space| space.scene.clone()),
            "profile": self.config.active_profile,
            "profiles": profile_options(
                &self.profile,
                &self.config,
                self.settings_candidate.as_ref(),
            ),
            "monitors": monitors,
            "previewActive": self.preview_active(),
            "mediaPreview": self.preview_diagnostics(),
            "mediaPreviewAvailable": true,
            "previewLease": self.preview_lease(),
            "lyricsConfig": self.position_edit.as_ref().map(|edit| &edit.lyrics).unwrap_or(&self.config.lyrics),
            "runtime": self.status_json(),
            "launchAtLogin": native::autostart_enabled().ok(),
            "recoveryHotkey": self.recovery_hotkey_json(),
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

    fn open_settings(&mut self, target: &EventLoopWindowTarget<()>) {
        if self.embedded {
            if let Some(events) = &self.settings_events {
                events(crate::settings_embedding::SettingsEvent::Navigate {
                    tab: self.settings_tab.clone(),
                });
            } else {
                log("wallpaper settings require the main player window");
            }
            return;
        }
        if let Some(settings) = self.settings.as_ref() {
            native::raise(settings.window.hwnd() as HWND);
            native::focus(settings.window.hwnd() as HWND);
            self.sync_settings_feed();
            self.send_settings_status(None, None);
            return;
        }
        self.settings_generation += 1;
        match create_settings(target, self.proxy.clone(), self.settings_generation, None) {
            Ok(settings) => {
                log("wallpaper settings opened");
                self.settings = Some(settings);
                self.settings_drafts.set_owner(self.settings_generation);
                self.wallpaper_ai.set_owner(self.settings_generation);
                self.wallpaper_library
                    .set_settings_owner(self.settings_generation);
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
        let document = self
            .settings
            .as_ref()
            .and_then(|settings| settings.placement.as_ref())
            .map(|placement| placement.document.clone());
        if self
            .position_edit
            .as_ref()
            .is_some_and(|edit| edit.owner.is_none())
        {
            let _ = self.finish_position_edit(false);
        }
        self.close_preview();
        self.settings_drafts.set_owner(0);
        self.wallpaper_ai.set_owner(0);
        self.wallpaper_library.set_settings_owner(0);
        self.settings_generation += 1;
        self.settings = None;
        self.settings_candidate = None;
        self.sync_settings_feed();
        if let (Some(events), Some(document)) = (&self.settings_events, document) {
            events(crate::settings_embedding::SettingsEvent::Closed { document });
        }
    }

    fn close_preview(&mut self) {
        self.work_preview_epoch = self.work_preview_epoch.wrapping_add(1);
        if self.close_preview_owner() {
            if let Some(settings) = self.settings.as_ref() {
                settings.eval("window.hertzWallpaperSettings && window.hertzWallpaperSettings.unmountPreview();");
            }
            log("wallpaper preview closed");
            self.send_settings_status(None, Some("预览已关闭"));
        }
    }

    fn ensure_wallpaper_feed(&mut self) {
        if self.config.active_profile.is_none() || self.feature_stops.wallpaper {
            return;
        }
        if config::is_dbx(&self.profile) {
            self.sync_dbx_feed();
            return;
        }
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
        self.source_health.fail(false);
        if let Some(stop) = self.wallpaper_feed_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    fn sync_settings_feed(&mut self) {
        self.sync_lyrics_feed();
        if config::is_dbx(&self.profile) {
            self.sync_dbx_feed();
            return;
        }
        if !self.feature_stops.wallpaper && (self.settings.is_some() || self.wallpaper_running()) {
            self.ensure_wallpaper_feed();
        } else {
            self.stop_wallpaper_feed();
        }
    }

    fn sync_dbx_feed(&mut self) {
        if !config::is_dbx(&self.profile) {
            return;
        }
        if self.dbx.is_none() {
            self.dbx = Some(crate::dbx_feed::Controller::start(
                self.profile.clone(),
                self.source_generation,
                self.proxy.clone(),
            ));
        }
        self.dbx
            .as_ref()
            .unwrap()
            .set_needs(crate::dbx_feed::Needs {
                lyrics: self.lyrics_needed(),
                wallpaper: !self.feature_stops.wallpaper
                    && (self.wallpaper_running() || self.settings.is_some()),
            });
    }
    fn handle_dbx(&mut self, message: crate::dbx_feed::Message) {
        use crate::dbx_feed::Message;
        use hertz_desktop_ipc::Scope;
        match message {
            Message::Session(session) => {
                if self.dbx_session.as_deref() != Some(session.as_str()) {
                    if self.lyrics_needed() {
                        self.handle_feed_error("DBX 来源会话已变化，等待新快照".into());
                    }
                    self.handle_wallpaper_feed(Err(FeedError {
                        code: "dbx_session_changed",
                        message: "DBX 来源会话已变化".into(),
                    }));
                    self.dbx_session = Some(session);
                }
            }
            Message::Lyrics {
                started,
                snapshot,
                cached_document,
            } => {
                if !self.lyrics_needed()
                    || started.elapsed() >= STALE_AFTER
                    || self.dbx_session.as_deref() != Some(snapshot.server.session.as_str())
                {
                    return;
                }
                if self.last_snapshot.as_ref().is_some_and(|old| {
                    old.server.session == snapshot.server.session && old.seq >= snapshot.seq
                }) {
                    return;
                }
                // A native expiry may have cleared the document during transport or
                // event queueing. Reuse the authenticated cache only when this accepted
                // snapshot needs it; ordinary snapshots never replay large JS documents.
                let needs_document = self.current_document.is_none()
                    || self.current_document_key != snapshot.lyrics.document_key
                    || self.current_track.as_deref()
                        != snapshot.track.as_ref().map(|track| track.id.as_str());
                let document = cached_document
                    .filter(|document| {
                        needs_document
                            && snapshot.lyrics.status == "ready"
                            && document.document_key == snapshot.lyrics.document_key
                    })
                    .map(|document| (*document).clone());
                self.source_health
                    .accept(true, started, &snapshot.server.session);
                self.last_update = started;
                // The original handler owns presentation/offset semantics. Set t0 before
                // dispatch so the first page delivery includes transport and native queue age.
                self.handle_timed_update(
                    crate::feed::FeedUpdate {
                        snapshot,
                        document,
                        warning: None,
                    },
                    started,
                );
            }
            Message::Wallpaper {
                started,
                mut snapshot,
            } => {
                if self.feature_stops.wallpaper
                    || started.elapsed() >= STALE_AFTER
                    || self.dbx_session.as_deref() != Some(snapshot.server.session.as_str())
                {
                    return;
                }
                if self.wallpaper_last.as_ref().is_some_and(|old| {
                    old.server.session == snapshot.server.session && old.seq >= snapshot.seq
                }) {
                    return;
                }
                snapshot.received_at = Some(started);
                self.wallpaper_last_update = Some(started);
                self.source_health
                    .accept(false, started, &snapshot.server.session);
                self.handle_wallpaper_feed(Ok(snapshot));
            }
            Message::Document {
                session,
                key,
                document,
            } => {
                if !self.lyrics_needed()
                    || self.last_update.elapsed() >= STALE_AFTER
                    || self.dbx_session.as_deref() != Some(session.as_str())
                    || self.last_snapshot.as_ref().is_none_or(|snapshot| {
                        snapshot.server.session != session
                            || snapshot.lyrics.status != "ready"
                            || snapshot.lyrics.document_key.as_deref() != Some(key.as_str())
                    })
                {
                    return;
                }
                self.current_document_key = Some(key);
                self.current_document = Some(document);
                self.policy.no_content = self.last_snapshot.as_ref().is_none_or(|snapshot| {
                    snapshot.track.is_none() || snapshot.lyrics.status != "ready"
                }) || (self.vocal_document_mode()
                    && self.config.lyrics.show_vocals
                    && self.lyrics_vocal_geometry().capacity == 0);
                self.place(true);
                self.send_document();
                self.recompute_visibility();
            }
            Message::Failure { scope, message } => {
                if self.lyrics_needed() && (scope.is_none() || scope == Some(Scope::Lyrics)) {
                    let permanent = [
                        crate::feed::DocumentError::Unsupported,
                        crate::feed::DocumentError::Invalid,
                    ]
                    .into_iter()
                    .find(|error| error.message() == message);
                    if let Some(error) = permanent {
                        self.handle_document_failure(error);
                    } else {
                        self.handle_feed_error(message.into());
                    }
                }
                if scope.is_none() || scope == Some(Scope::Wallpaper) {
                    self.handle_wallpaper_feed(Err(FeedError {
                        code: "dbx_source_unavailable",
                        message: message.into(),
                    }));
                }
            }
        }
    }

    fn ensure_wallpaper_surface(&mut self, target: &EventLoopWindowTarget<()>) -> Result<()> {
        let mut failure = None;
        self.for_each_desktop(|app| {
            if let Err(error) = app.ensure_wallpaper_surface_target(target) {
                app.desktop.apply_error = Some(error.to_string());
                failure.get_or_insert(error);
            }
        });
        failure.map_or(Ok(()), Err)
    }

    fn ensure_wallpaper_surface_target(
        &mut self,
        target: &EventLoopWindowTarget<()>,
    ) -> Result<()> {
        if !self.wallpaper_target_running(&self.desktop.configuration) {
            return Ok(());
        }
        if self.desktop.handoff.is_some()
            || self.desktop.candidate.is_some()
            || self.desktop.prepared.is_some()
        {
            return Ok(());
        }
        if self.desktop.configuration.builtin().is_none() {
            return self.ensure_media_wallpaper(target);
        }
        validate_current_presentation(&self.desktop.configuration).map_err(anyhow::Error::msg)?;

        let Some(resolved) = self.desktop_monitor() else {
            self.desktop.monitor_missing = true;
            bail!("目标显示器未连接，请在设置中重新认领");
        };
        self.desktop.monitor_missing = false;
        self.desktop.topology_misses = 0;
        let surface_stale = self.desktop.surface.as_ref().is_some_and(|surface| {
            surface.monitor.display_id() != resolved.display_id()
                || monitor_geometry_changed(&surface.monitor, &resolved)
        });
        if surface_stale
            || self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| !native::wallpaper_alive(surface.hwnd()))
        {
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
        }
        if self.desktop.surface.is_none() {
            return self.stage_builtin_wallpaper(target);
        }
        Ok(())
    }

    fn retire_wallpaper_surface(&mut self) {
        if self.is_mirror_target()
            && self.desktop.failed_revision.is_none()
            && self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| self.mirror_surface_matches(surface))
        {
            self.desktop.mirror_rebuild = true;
            self.desktop.mirror_released = false;
            self.desktop.mirror_presented = None;
        }
        if let Some(surface) = self.desktop.surface.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        self.poll_wallpaper_retirements();
    }

    fn poll_wallpaper_retirements(&mut self) {
        let mut closed = Vec::new();
        self.wallpaper_retiring.retain_mut(|retiring| {
            let done = retiring.poll();
            if retiring.surface.is_none() {
                closed.push(retiring.generation);
            }
            !done
        });
        for generation in closed {
            self.handoff_source_closed(generation);
        }
        self.poll_handoff_retirements();
    }

    fn drop_wallpaper_surface(&mut self) {
        self.for_each_desktop(|app| app.drop_wallpaper_surface_target());
    }

    fn drop_wallpaper_surface_target(&mut self) {
        self.close_wallpaper_handoff();
        self.desktop.playback = None;
        self.desktop.policy_poster = None;
        self.cancel_wallpaper_transition();
        self.retire_wallpaper_surface();
        self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
        self.desktop.page_ready = false;
        self.desktop.visible = false;
        self.reset_wallpaper_page_stats();
    }

    fn switch_source(
        &mut self,
        profile: Profile,
        expected_revision: u64,
        target: &EventLoopWindowTarget<()>,
    ) -> Result<(), String> {
        if self.position_edit.is_some() {
            return Err("请先完成或取消位置调整".into());
        }
        if self.save_due.is_some() || expected_revision != self.config.revision {
            return Err("设置已变化，请重新打开设置后重试".into());
        }
        let profile = config::normalize_profile(profile).map_err(|error| format!("{error:#}"))?;
        self.cancel_calibration();
        if self
            .config
            .active_profile
            .as_ref()
            .is_some_and(|active| config::same_profile(active, &profile))
        {
            return Err("已经是当前来源".into());
        }
        let next_generation = self
            .source_generation
            .checked_add(1)
            .ok_or("来源 generation 已达上限")?;
        let mut next = self.config.clone();
        next.activate_profile(profile.clone())
            .map_err(|error| format!("{error:#}"))?;
        config::commit(&mut self.config, next)
            .map_err(|error| format!("保存设置失败：{error:#}"))?;
        self.committed_config = self.config.clone();
        self.feature_stops = feature_exit::FeatureStops::default();
        self.reconcile_desktops(&native::wallpaper_monitors(), Instant::now())
            .map_err(|error| error.to_string())?;
        self.close_preview();
        self.settings_drafts.clear();
        self.profile = profile;
        self.source_generation = next_generation;
        self.restart_mini_source(target);
        self.dbx = None;
        self.dbx_session = None;
        self.source_health = crate::management::SourceHealth::default();
        self.wallpaper_last_update = None;
        self.lyrics_feed_stop.store(true, Ordering::Relaxed);

        self.stop_wallpaper_feed();
        self.wallpaper_last = None;
        self.wallpaper_feed_logged = false;
        for surface in self
            .desktop
            .runtimes
            .values()
            .filter_map(|desktop| desktop.surface.as_ref())
        {
            surface.clear_feed();
        }
        if let Some(preview) = self.preview_surface() {
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
        self.source_message = Some(format!("正在连接 Hertz {} 服务", self.profile.edition()));
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
        self.for_each_desktop(|app| {
            if let Err(error) =
                app.apply_desktop_settings(app.desktop.configuration.clone(), target)
            {
                surface_error.get_or_insert(error);
            }
        });
        if self.config.wallpaper.enabled || self.wallpaper_forced {
            self.ensure_wallpaper_feed();
        }
        self.sync_settings_feed();
        for desktop in self.desktop.runtimes.values_mut() {
            desktop.recovery_terminal = false;
            desktop.recovery_attempts.clear();
        }
        self.recompute_wallpaper();
        self.rebuild_tray();
        log(&format!(
            "source switched edition={} data_dir={}",
            self.profile.edition(),
            std::path::Path::new(self.profile.data_dir()).display()
        ));
        self.send_settings_status(surface_error.as_deref(), Some("已切换来源"));
        Ok(())
    }

    fn apply_wallpaper_settings(
        &mut self,
        candidate: &WallpaperCandidate,
        expected_revision: u64,
        target: &EventLoopWindowTarget<()>,
        lyrics: Option<config::LyricsConfig>,
    ) -> Result<(), String> {
        if self.position_edit.is_some() {
            return Err("请先完成或取消位置调整".into());
        }
        let candidate = candidate.normalized()?;
        if self.save_due.is_some() || expected_revision != self.config.revision {
            return Err("设置已在其他位置变化；草稿已保留，请放弃修改后重新读取".into());
        }
        let resume_lyrics = lyrics.as_ref().is_some_and(|lyrics| lyrics.enabled);
        let mut next = self.config.clone();
        if let Some(lyrics) = lyrics {
            if lyrics.locked && !self.can_lock_lyrics() {
                return Err("托盘不可用，暂时无法锁定歌词".into());
            }
            next.lyrics = lyrics;
            next.sanitize();
        }
        next.wallpaper = candidate.clone();
        config::commit(&mut self.config, next)
            .map_err(|error| format!("保存设置失败：{error:#}"))?;
        if resume_lyrics {
            self.resume_lyrics();
        }
        self.apply_saved_wallpaper_settings(candidate, target)
    }

    fn apply_saved_wallpaper_settings(
        &mut self,
        candidate: config::WallpaperConfig,
        target: &EventLoopWindowTarget<()>,
    ) -> Result<(), String> {
        if candidate.enabled {
            self.feature_stops.wallpaper = false;
            self.feature_stops.wallpaper_save_failed = false;
        }
        self.reconcile_desktops(&native::wallpaper_monitors(), Instant::now())
            .map_err(|error| error.to_string())?;
        self.close_preview();
        self.wallpaper_audio_dispatch.invalidate();
        self.committed_config = self.config.clone();
        self.settings_drafts.clear();
        self.wallpaper_forced = false;
        // 歌词已唱色随配置提交同步给小窗 accent（无小窗时是空操作）。
        self.mini_send_config();
        // 保存成功与运行失败分离（设计 C01/C02）：以下任何运行失败都保留
        // 新 revision 与意图，只把错误独立呈现给设置页，不回写旧配置。
        let mut run_error = None;
        self.for_each_desktop(|app| {
            let Some(projected) =
                wallpaper_runtime::project_group(&candidate, &app.desktop.configuration.main().id)
            else {
                return;
            };
            if app.desktop.desired_revision != app.config.revision && app.desktop.prepared.is_none()
            {
                return;
            }
            if let Err(error) = app.apply_desktop_settings(projected, target) {
                run_error.get_or_insert(error);
            }
        });
        self.sync_settings_feed();
        self.recompute_wallpaper();
        self.policy.locked = self.config.lyrics.locked;
        native::set_locked(self.hwnd(), self.policy.locked);
        self.send_config();
        self.place(true);
        self.recompute_visibility();
        self.rebuild_tray();
        match run_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn apply_desktop_settings(
        &mut self,
        candidate: config::WallpaperConfig,
        target: &EventLoopWindowTarget<()>,
    ) -> Result<(), String> {
        self.desktop
            .configure(candidate.clone(), self.config.revision);
        let mut run_error = None;
        if self.wallpaper_target_running(&candidate) {
            let mut mount = Ok(());
            if candidate.builtin().is_some() {
                self.cancel_wallpaper_transition();
                if self.desktop.handoff.is_some()
                    || self.desktop.surface.as_ref().is_some_and(|surface| {
                        surface.session.media().is_some()
                            || surface.configuration.presentation().fps
                                != candidate.presentation().fps
                            || surface.configuration.presentation().quality
                                != candidate.presentation().quality
                            || serde_json::to_value(&surface.configuration.main().selection)
                                .expect("old selection")
                                != serde_json::to_value(&candidate.main().selection)
                                    .expect("new selection")
                    })
                {
                    // A builtin replacement uses its own controller and first-frame gate.
                    mount = self.stage_builtin_wallpaper(target);
                } else if let Some(surface) = self.desktop.surface.as_mut() {
                    surface.configuration = candidate.clone();
                }
            }
            if let Err(error) = mount.and_then(|()| self.ensure_wallpaper_surface(target)) {
                log(&format!("wallpaper enable failed: {error:#}"));
                self.desktop.apply_error = Some(error.to_string());
                run_error = Some(format!("设置已保存，但壁纸挂载失败：{error}"));
            } else {
                self.desktop.apply_error = None;
                self.ensure_wallpaper_feed();
                if let Some(surface) = self.desktop.surface.as_ref() {
                    surface.apply_config(&surface.configuration, surface.monitor.refresh_hz);
                    if self.desktop.page_ready {
                        if let Some(snapshot) = self.wallpaper_last.as_ref() {
                            surface.apply_feed(snapshot);
                        } else {
                            surface.clear_feed();
                        }
                    }
                }
            }
        } else {
            self.drop_wallpaper_surface();
            self.desktop.apply_error = None;
        }
        run_error.map_or(Ok(()), Err)
    }

    fn begin_position_edit(&mut self) -> Result<(), String> {
        if let Some(edit) = self.position_edit.as_ref() {
            if edit.owner.is_some() {
                return Err("请在发起调整的主程序页面中完成或取消位置调整".into());
            }
            return Ok(());
        }
        if self.save_due.is_some() {
            self.save_due = Some(Instant::now());
            self.flush_save();
        }
        self.position_edit = Some(PositionEdit {
            lyrics: self.config.lyrics.clone(),
            user_hidden: self.policy.user_hidden,
            session_stopped: self.feature_stops.lyrics,
            exit_save_failed: self.feature_stops.lyrics_save_failed,
            owner: None,
        });
        self.config.lyrics.enabled = true;
        self.resume_lyrics();
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
        if commit {
            config::next_revision(self.config.revision).map_err(|error| error.to_string())?;
        }
        let Some(edit) = self.position_edit.take() else {
            return Ok(());
        };
        let moved = self.config.lyrics.clone();
        let mut restored = self.config.clone();
        restored.lyrics = edit.lyrics;
        self.feature_stops.lyrics |= edit.session_stopped;
        self.feature_stops.lyrics_save_failed |= edit.exit_save_failed;
        self.policy.user_hidden = edit.user_hidden;
        let result = if commit {
            let mut next = restored.clone();
            next.lyrics.anchor_x = moved.anchor_x;
            next.lyrics.anchor_y = moved.anchor_y;
            next.lyrics.monitor = moved.monitor;
            config::commit(&mut restored, next).map_err(|error| format!("保存位置失败：{error:#}"))
        } else {
            Ok(())
        };
        self.config = restored;
        if !self.lyrics_needed() {
            self.clear_lyrics_runtime();
        }
        self.sync_lyrics_feed();
        if result.is_ok() && commit {
            self.committed_config = self.config.clone();
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

    fn submit_wallpaper_management(
        &mut self,
        value: serde_json::Value,
        reply: ApiReply,
        target: &EventLoopWindowTarget<()>,
    ) {
        if value
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| command.starts_with("wallpaper.ai."))
        {
            self.handle_ai_management(value, reply, target);
            return;
        }
        use crate::wallpaper::{api, jobs::JobError};
        let request_id = value
            .get("requestId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let request = match api::Request::parse(value) {
            Ok(request) => request,
            Err(error) => {
                self.send_wallpaper_management(
                    reply,
                    api::response(request_id.as_deref(), Err(error), None),
                );
                return;
            }
        };
        let owner = match &reply {
            ApiReply::Settings(generation)
                if self.settings.is_some() && *generation == self.settings_generation =>
            {
                *generation
            }
            _ => 0,
        };
        let typed = request.typed().ok();
        if typed.as_ref().is_some_and(|command| {
            matches!(
                command,
                crate::wallpaper::api::Command::DraftUpdate { .. }
                    | crate::wallpaper::api::Command::PlaylistNext { .. }
                    | crate::wallpaper::api::Command::Apply { .. }
            )
        }) {
            self.wallpaper_ai.invalidate();
        }
        if typed
            .as_ref()
            .is_some_and(crate::wallpaper::api::Command::settings_command)
        {
            if let Some(result) =
                self.handle_settings_management(&request, owner, reply.clone(), target)
            {
                self.send_wallpaper_management(reply, result);
            }
            return;
        }
        let references = typed
            .as_ref()
            .map(|command| self.library_reference_snapshot(command))
            .unwrap_or_default();
        if typed.as_ref().is_some_and(|command| {
            matches!(
                command,
                crate::wallpaper::api::Command::LibraryDeleteWork { .. }
                    | crate::wallpaper::api::Command::LibraryDeleteVersion { .. }
            )
        }) {
            if self.library_delete.is_some() {
                self.send_wallpaper_management(
                    reply,
                    api::response(
                        Some(&request.request_id),
                        Err(JobError::new("conflict", "已有作品删除操作正在进行")),
                        None,
                    ),
                );
                return;
            }
            self.library_delete = Some(request.request_id.clone());
        }
        let hwnd = if owner != 0 {
            self.settings
                .as_ref()
                .map_or(0, |settings| settings.window.hwnd())
        } else {
            0
        };
        let proxy = self.proxy.clone();
        let destination = reply.clone();
        let changes_playlist = matches!(typed, Some(api::Command::PlaylistSave { .. }));
        let deletes_library = matches!(
            typed,
            Some(
                api::Command::LibraryDeleteWork { .. } | api::Command::LibraryDeleteVersion { .. }
            )
        );
        let deletion_id = deletes_library.then(|| request.request_id.clone());
        let playlist_properties = match &typed {
            Some(api::Command::PlaylistSave {
                playlist_id: Some(id),
                ..
            }) => self.config.playlist_property_overrides(id),
            _ => vec![],
        };
        if changes_playlist {
            self.playlist_writes += 1;
            if let Some(api::Command::PlaylistSave {
                playlist_id: Some(id),
                ..
            }) = &typed
            {
                if let Some(transaction) = &self.wallpaper_apply {
                    transaction.cancel_for_playlist(id);
                }
            }
        }
        if let Err(error) = self.wallpaper_library.submit_with_context(
            request,
            owner,
            hwnd,
            playlist_properties,
            references,
            move |value| {
                if let Some(id) = deletion_id {
                    let _ = proxy.send_event(UserEvent::LibraryDeleteFinished(id));
                }
                if changes_playlist {
                    let saved = (value["ok"].as_bool() == Some(true))
                        .then(|| value["result"]["playlistId"].as_str().map(str::to_owned))
                        .flatten();
                    let _ = proxy.send_event(UserEvent::PlaylistWriteFinished(saved));
                }
                let _ = proxy.send_event(UserEvent::WallpaperManagement(destination, value));
            },
        ) {
            if changes_playlist {
                self.playlist_writes -= 1;
            }
            if deletes_library && self.library_delete.as_deref() == request_id.as_deref() {
                self.library_delete = None;
            }
            self.send_wallpaper_management(
                reply,
                api::response(
                    request_id.as_deref(),
                    Err(JobError::new(error.code, error.message)),
                    None,
                ),
            );
        }
    }

    /// 删除前的引用快照。配置、未应用草稿、内置/媒体预览、候选/准备中的
    /// 固定版本都可能仍读取包；任何一处命中都返回 asset_in_use。
    fn library_reference_snapshot(
        &self,
        command: &crate::wallpaper::api::Command,
    ) -> crate::wallpaper::references::Report {
        use crate::wallpaper::api::Command;
        let (work_key, package_hash) = match command {
            Command::LibraryDeleteWork { work_key } => (Some(work_key.as_str()), None),
            Command::LibraryDeleteVersion { package_hash, .. } => {
                (None, Some(package_hash.as_str()))
            }
            Command::LibraryReferences {
                work_key,
                package_hash,
            } => {
                if let Some(hash) = package_hash {
                    (None, Some(hash.as_str()))
                } else {
                    (Some(work_key.as_str()), None)
                }
            }
            _ => return Default::default(),
        };
        let mut report = self.config.wallpaper_references(work_key, package_hash);
        if self
            .settings_drafts
            .current()
            .is_some_and(|draft| draft.wallpaper.references_package(work_key, package_hash))
        {
            report.push(
                "settingsDraft",
                "settings",
                "尚未应用的设置草稿",
                "应用其它作品选择，或放弃此设置草稿后解除引用。",
            );
        }
        for (id, desktop) in &self.desktop.runtimes {
            for (phase, surface) in desktop
                .surface
                .iter()
                .map(|surface| ("当前画面", surface))
                .chain(
                    desktop
                        .candidate
                        .iter()
                        .map(|surface| ("候选画面", surface)),
                )
            {
                if surface
                    .configuration
                    .references_package(work_key, package_hash)
                    || surface
                        .runtime_reference
                        .as_ref()
                        .is_some_and(|value| value.matches(work_key, package_hash))
                {
                    report.push(
                        "desktop",
                        &format!("{id}:{phase}"),
                        &format!("显示组 {} · {phase}", desktop.configuration.main().id),
                        "切换作品后等待窗口与文件读取退出。",
                    );
                }
            }
            if desktop
                .prepared
                .iter()
                .chain(desktop.policy_poster.iter())
                .any(|prepared| prepared.references_package(work_key, package_hash))
            {
                report.push(
                    "preparing",
                    &format!("{id}:prepared"),
                    &format!("显示组 {} · 已准备内容", desktop.configuration.main().id),
                    "包含暂停保留的故障封面。切换此组选择以释放。",
                );
            }
            if desktop
                .selection
                .as_ref()
                .is_some_and(|task| task.references_package(work_key, package_hash))
            {
                report.push(
                    "preparing",
                    &format!("{id}:selection"),
                    &format!("显示组 {} · 正在解析", desktop.configuration.main().id),
                    "内容准备尚未退出；未确定的轮播引用会暂时保护作品。",
                );
            }
        }
        for (id, group) in &self.desktop.mirrors {
            if group
                .playback
                .current()
                .is_some_and(|reference| reference.matches(work_key, package_hash))
                || group
                    .playback
                    .switch()
                    .is_some_and(|switch| switch.reference.matches(work_key, package_hash))
                || group.playback.playlist().is_some_and(|playlist| {
                    playlist
                        .items
                        .iter()
                        .any(|reference| reference.matches(work_key, package_hash))
                })
            {
                report.push(
                    "desktop",
                    &format!("mirror-{id}"),
                    &format!("镜像组 {id}"),
                    "组播放仍保留此版本；切换组选择后再删除。",
                );
            }
        }
        for retiring in &self.wallpaper_retiring {
            if retiring
                .configuration
                .references_package(work_key, package_hash)
                || retiring
                    .runtime_reference
                    .as_ref()
                    .is_some_and(|v| v.matches(work_key, package_hash))
            {
                report.push(
                    "retiring",
                    &format!("controller-{}", retiring.generation),
                    "正在退出的呈现窗口",
                    "等待原生窗口与文件读者退出后刷新引用。",
                );
            }
        }
        for handoff in self
            .desktop
            .runtimes
            .values()
            .filter_map(|desktop| desktop.handoff.as_ref())
            .chain(self.wallpaper_handoff_retiring.iter())
        {
            if handoff
                .configuration
                .references_package(work_key, package_hash)
                || handoff
                    .runtime_reference
                    .as_ref()
                    .is_some_and(|v| v.matches(work_key, package_hash))
            {
                report.push(
                    "retiring",
                    &format!("handoff-{}", handoff.hold.request.generation),
                    "交接或暂停保留的静态画面",
                    "静态画面仍归当前显示目标持有，切换作品后等待交接完成。",
                );
            }
        }
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| preview.references_package(work_key, package_hash))
        {
            report.push(
                "preview",
                "preview",
                "独立预览",
                "结束预览并等待资源释放后刷新引用。",
            );
        }
        if self
            .wallpaper_apply
            .as_ref()
            .is_some_and(|transaction| transaction.references_package(work_key, package_hash))
        {
            report.push(
                "applying",
                "settings-apply",
                "正在应用的设置",
                "待应用事务完成或取消后刷新引用。",
            );
        }
        report
    }

    fn handle_settings_management(
        &mut self,
        request: &crate::wallpaper::api::Request,
        owner: u64,
        reply: ApiReply,
        target: &EventLoopWindowTarget<()>,
    ) -> Option<serde_json::Value> {
        use crate::wallpaper::{api, jobs::JobError};
        let slot = match self.wallpaper_library.reserve() {
            Ok(slot) => slot,
            Err(error) => return Some(api::response(Some(&request.request_id), Err(error), None)),
        };
        if matches!(request.typed(), Ok(api::Command::Apply { .. })) {
            let replay = crate::config_journal::caller_sid().and_then(|caller_sid| {
                config::replay_request(&crate::config_journal::Intent {
                    request_id: request.request_id.clone(),
                    payload_digest: request.digest(),
                    command: request.command.clone(),
                    caller_sid,
                })
            });
            match replay {
                Ok(Some(operation)) => {
                    return Some(api::response(
                        Some(&request.request_id),
                        Ok(serde_json::to_value(operation).expect("operation")),
                        None,
                    ))
                }
                Err(error) => {
                    return Some(api::response(
                        Some(&request.request_id),
                        Err(JobError::new(
                            crate::config_journal::error_code(&error, "config_conflict"),
                            error.to_string(),
                        )),
                        None,
                    ))
                }
                Ok(None) => {}
            }
        }
        if owner == 0 || owner != self.settings_generation || self.settings.is_none() {
            return Some(api::response(
                Some(&request.request_id),
                Err(JobError::new(
                    "settings_session_required",
                    "请在当前设置中心管理草稿和预览",
                )),
                None,
            ));
        }
        if self.library_delete.is_some()
            && matches!(
                request.typed(),
                Ok(api::Command::DraftUpdate { .. }
                    | api::Command::Apply { .. }
                    | api::Command::PreviewAcquire { .. }
                    | api::Command::PreviewUpdate { .. })
            )
        {
            return Some(api::response(
                Some(&request.request_id),
                Err(JobError::new(
                    "conflict",
                    "正在删除作品，请等待完成后再修改设置",
                )),
                None,
            ));
        }
        match self.wallpaper_library.begin_local(request) {
            Ok(Some(receipt)) => return Some(receipt),
            Err(error) => return Some(api::response(Some(&request.request_id), Err(error), None)),
            Ok(None) => {}
        }
        let result = if matches!(request.typed(), Ok(api::Command::Apply { .. })) {
            match self.begin_wallpaper_apply(request.clone(), owner, reply, slot) {
                Ok(()) => return None,
                Err(error) => Err(error),
            }
        } else if self.work_preview_request(request) {
            match self.begin_work_preview(request.clone(), owner, reply, slot) {
                Ok(()) => return None,
                Err(error) => Err(error),
            }
        } else if self.preview_request(request) {
            self.begin_preview(request, owner, slot, target)
        } else {
            self.execute_settings_management(request, owner)
        };
        let mut receipt = api::response(Some(&request.request_id), result, None);
        receipt["configRevision"] = receipt["result"]["configRevision"]
            .as_u64()
            .unwrap_or(self.config.revision)
            .into();
        self.wallpaper_library.finish_local(request, &receipt);
        Some(receipt)
    }

    fn execute_settings_management(
        &mut self,
        request: &crate::wallpaper::api::Request,
        owner: u64,
    ) -> Result<serde_json::Value, crate::wallpaper::jobs::JobError> {
        use crate::wallpaper::{api::Command, jobs::JobError};
        use serde_json::json;
        let draft_receipt = |draft: &crate::wallpaper::settings_drafts::Draft| {
            serde_json::to_value(draft.receipt()).expect("draft receipt")
        };
        Ok(match request.typed()? {
            Command::PlaylistNext {
                playlist_id,
                retry,
                group_id,
            } => self.playlist_next(&playlist_id, group_id.as_deref(), retry)?,
            Command::DraftCreate => {
                if self.save_due.is_some() || self.position_edit.is_some() {
                    return Err(JobError::new("conflict", "请先完成当前设置修改"));
                }
                draft_receipt(self.settings_drafts.create(owner, &self.config)?)
            }
            Command::DraftUpdate {
                draft_id,
                draft_revision,
                operations,
            } => draft_receipt(self.settings_drafts.update(
                owner,
                &draft_id,
                draft_revision,
                operations,
            )?),
            Command::DraftDiscard {
                draft_id,
                draft_revision,
            } => {
                self.settings_drafts
                    .discard(owner, &draft_id, draft_revision)?;
                self.close_preview();
                json!({"discarded":true})
            }
            Command::PreviewRenew { lease_id } => {
                self.check_preview_owner(owner, &lease_id)?;
                if let Some(preview) = self.preview.as_mut() {
                    preview.lease_until = Instant::now() + PREVIEW_LEASE;
                }
                json!({"leaseId":lease_id,"expiresInMs":15000})
            }
            Command::PreviewRelease { lease_id } => {
                self.check_preview_owner(owner, &lease_id)?;
                self.close_preview();
                json!({"released":true})
            }
            _ => {
                return Err(JobError::new(
                    "unsupported_command",
                    "此命令不属于设置草稿入口",
                ))
            }
        })
    }

    fn check_preview_owner(
        &self,
        owner: u64,
        lease_id: &str,
    ) -> Result<(), crate::wallpaper::jobs::JobError> {
        if owner == 0
            || owner != self.settings_generation
            || self.preview_lease() != Some(lease_id)
            || self
                .preview
                .as_ref()
                .map(|preview| preview.lease_until)
                .is_none_or(|until| until <= Instant::now())
        {
            return Err(crate::wallpaper::jobs::JobError::new(
                "preview_lease_invalid",
                "预览租约已过期或不属于当前设置会话",
            ));
        }
        Ok(())
    }

    fn send_wallpaper_management(&mut self, reply: ApiReply, mut value: serde_json::Value) {
        if value["configRevision"].is_null() {
            value["configRevision"] = value["result"]["configRevision"]
                .as_u64()
                .unwrap_or(self.config.revision)
                .into();
        }
        if hertz_desktop_ipc::frame::serialize_bounded(
            &value,
            hertz_desktop_ipc::management::RESPONSE_LIMIT,
        )
        .is_err()
        {
            value = crate::wallpaper::api::response(
                value["requestId"].as_str(),
                Err(crate::wallpaper::jobs::JobError::new(
                    "response_too_large",
                    "响应超过 64 KiB，请缩小分页",
                )),
                None,
            );
            value["configRevision"] = value["result"]["configRevision"]
                .as_u64()
                .unwrap_or(self.config.revision)
                .into();
        }
        match reply {
            ApiReply::Settings(generation) if generation == self.settings_generation => {
                if let Some(settings) = self.settings.as_ref() {
                    settings.eval(&format!("window.hertzWallpaperSettings && window.hertzWallpaperSettings.applyManagement({value});"));
                }
            }
            ApiReply::Pipe(reply, admission) if admission.is_valid() => {
                let _ = reply.send(value);
            }
            ApiReply::Host(reply) => {
                let _ = reply.send(value);
            }
            _ => {}
        }
    }

    fn handle_settings_page(&mut self, body: &str, target: &EventLoopWindowTarget<()>) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
            if value
                .get("command")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|command| command.starts_with("wallpaper.ai."))
            {
                if let Err(error) = hertz_wallpaper::json::check_bounded_json(body.as_bytes(), 8) {
                    self.send_wallpaper_management(
                        ApiReply::Settings(self.settings_generation),
                        crate::wallpaper::api::response(
                            value["requestId"].as_str(),
                            Err(crate::wallpaper::jobs::JobError::invalid_input(
                                error.to_string(),
                            )),
                            None,
                        ),
                    );
                    return;
                }
            }
            if value.get("protocol").is_some()
                || value
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|command| command.starts_with("wallpaper."))
            {
                self.submit_wallpaper_management(
                    value,
                    ApiReply::Settings(self.settings_generation),
                    target,
                );
                return;
            }
        }
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
            enabled: Option<bool>,
            #[serde(default)]
            lease: Option<String>,
            #[serde(default)]
            hotkey: Option<String>,
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
                    | "preview-renew"
                    | "preview-close"
                    | "preview-bounds"
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
            "ready" => {
                // 迁移说明只在设置页首次就绪时展示一次。
                let notice = self.migration_notice.take();
                self.send_settings_status(None, notice.as_deref());
                if let Some(settings) = self.settings.as_mut() {
                    settings.ready = true;
                }
                self.settings_ready();
            }
            "preview-bounds" => self.preview_bounds(body),
            "status" => self.send_settings_status(None, None),
            "audio-retry" => {
                self.wallpaper_audio.retry();
                self.send_settings_status(None, Some("已请求重试系统音频"));
            }
            "preview-close" => {
                if let Some(preview) = self.preview.as_ref() {
                    if command.lease.as_deref() != Some(preview.lease_id.as_str()) {
                        self.send_settings_status(Some("预览租约不匹配"), None);
                        return;
                    }
                }
                self.close_preview();
            }
            "position-begin" => {
                let result = self.begin_position_edit();
                self.send_settings_status(
                    result.as_ref().err().map(String::as_str),
                    Some("拖动桌面歌词后，返回此处完成或取消"),
                );
            }
            "position-done" | "position-cancel" => {
                if self
                    .position_edit
                    .as_ref()
                    .is_some_and(|edit| edit.owner.is_some())
                {
                    self.send_settings_status(
                        Some("请在发起调整的主程序页面中完成或取消位置调整"),
                        None,
                    );
                    return;
                }
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
                let mut next = self.config.clone();
                next.launch_at_login = enable;
                let result = native::set_autostart(enable)
                    .and_then(|_| config::commit(&mut self.config, next));
                if result.is_err() {
                    self.config = previous;
                    let _ = native::set_autostart(previous_native);
                }
                if result.is_ok() {
                    self.committed_config = self.config.clone();
                }
                self.sync_tray();
                let error = result
                    .err()
                    .map(|error| format!("开机启动设置失败：{error:#}"));
                self.send_settings_status(error.as_deref(), None);
            }
            "recovery-hotkey" => {
                let Some(expected_revision) = command.expected_revision else {
                    self.send_settings_status(Some("缺少设置修订号"), None);
                    return;
                };
                if expected_revision != self.config.revision {
                    self.send_settings_status(Some("设置已变化，请读取最新状态后重试"), None);
                    return;
                }
                let desired = match command.hotkey.as_deref() {
                    None | Some("") => None,
                    Some(value) => match value.parse::<crate::hotkey::Shortcut>() {
                        Ok(shortcut) => Some(shortcut),
                        Err(error) => {
                            self.send_settings_status(Some(&error), None);
                            return;
                        }
                    },
                };
                let saved_before = self.config.recovery_hotkey.clone();
                let mut manager = self.hotkey.take();
                // Manager 在事务期间移出 App，让持久化闭包独占 self.config；
                // 每次成功提交（含补偿写回）都把 self.config 推进到磁盘真实状态。
                let result = match manager.as_mut() {
                    Some(manager) => manager.replace(saved_before.as_ref(), desired, |desired| {
                        let mut next = self.config.clone();
                        next.recovery_hotkey = desired.cloned();
                        match config::commit(&mut self.config, next) {
                            Ok(()) => crate::hotkey::PersistOutcome {
                                saved: self.config.recovery_hotkey.clone(),
                                result: Ok(()),
                            },
                            Err(error) => crate::hotkey::PersistOutcome {
                                saved: self.config.recovery_hotkey.clone(),
                                result: Err(format!("{error:#}")),
                            },
                        }
                    }),
                    None => Err("快捷键模块不可用".into()),
                };
                self.hotkey = manager;
                // 事务收尾时 config::commit 已把内存推进到与磁盘一致；
                // committed_config 同步为真实保存值，避免普通歌词编辑回滚到旧修订。
                self.committed_config = self.config.clone();
                self.send_settings_status(
                    result.as_ref().err().map(String::as_str),
                    result.is_ok().then_some("已更新恢复快捷键"),
                );
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
                    self.send_settings_status(Some(&error), None);
                    return;
                }
                match self.open_preview(target, &candidate) {
                    Ok(()) => self.send_settings_status(None, Some("预览已打开")),
                    Err(error) => self.send_settings_status(Some(&error), None),
                }
            }
            "preview-renew" => self.renew_preview(command.lease.as_deref()),
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

    fn set_locked(&mut self, locked: bool) {
        if locked && !self.can_lock_lyrics() {
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
        let was_enabled = self.config.lyrics.enabled;
        self.config.lyrics.enabled = true;
        self.resume_lyrics();
        self.policy.user_hidden = false;
        if self.config.lyrics.locked {
            self.config.lyrics.locked = false;
            self.policy.locked = false;
            native::set_locked(self.hwnd(), false);
            self.eval("window.hertzLyrics && window.hertzLyrics.setLocked(false);");
            self.schedule_save();
        }
        self.panel_top = None;
        if !was_enabled {
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
        let next = self.config.clone();
        let mut committed = self.committed_config.clone();
        let result = config::commit(&mut committed, next);
        match result {
            Ok(()) => {
                self.config = committed;
                self.committed_config = self.config.clone();
            }
            Err(error) => {
                let restore_autostart =
                    self.config.launch_at_login != self.committed_config.launch_at_login;
                self.config = self.committed_config.clone();
                let mut restore_error = None;
                if restore_autostart {
                    if let Err(error) = native::set_autostart(self.config.launch_at_login) {
                        log(&format!("restore autostart after failed save: {error:#}"));
                        restore_error = Some(error);
                    }
                }
                // Ordinary edits apply immediately. Rollback must restore their
                // window/page effects along with the durable intent and revision.
                self.policy.locked = self.config.lyrics.locked;
                native::set_locked(self.hwnd(), self.policy.locked);
                self.panel_top = None;
                if self.policy.locked {
                    self.panel_height = 0.0;
                }
                self.send_config();
                self.place(true);
                self.recompute_visibility();
                self.sync_settings_feed();
                self.sync_tray();
                log(&format!("save config failed: {error:#}"));
                let message = restore_error.map_or_else(
                    || "未保存，已恢复上次设置".to_string(),
                    |error| {
                        format!("未保存，已恢复上次歌词与壁纸设置；Windows 启动项恢复失败：{error}")
                    },
                );
                self.send_settings_status(Some(&message), None);
                return;
            }
        }
        self.send_settings_status(None, None);
    }

    fn sync_tray(&self) {
        if let Some(actions) = self.tray_actions.as_ref() {
            actions
                .toggle
                .set_checked(self.lyrics_running() && !self.policy.user_hidden);
            actions.toggle.set_enabled(self.lyrics_running());
            actions.lyrics_exit.set_enabled(self.lyrics_running());
            actions.wallpaper_exit.set_enabled(self.wallpaper_running());
            if let Ok(enabled) = native::autostart_enabled() {
                actions.autostart.set_checked(enabled);
            }
            if let Some(toggle) = actions.wallpaper_toggle.as_ref() {
                toggle.set_checked(self.wallpaper_running() && !self.wallpaper_hidden);
                toggle.set_enabled(self.wallpaper_running());
            }
            actions
                .mini_toggle
                .set_checked(self.mini_host.phase != MiniPhase::Hidden);
        }
    }

    // --- 小窗播放（桌面宠物）-------------------------------------------------

    fn mini_hwnd(&self) -> Option<HWND> {
        self.mini.as_ref().map(|mini| mini.hwnd)
    }

    fn mini_eval(&self, script: &str) {
        if !self.mini_page_ready {
            return;
        }
        let Some(mini) = self.mini.as_ref() else {
            return;
        };
        if let Err(error) = mini.webview.evaluate_script(script) {
            log(&format!("mini evaluate_script failed: {error}"));
        }
    }

    fn restart_mini_source(&mut self, target: &EventLoopWindowTarget<()>) {
        self.mini_runtime.stop.store(true, Ordering::Relaxed);
        if let Some(hwnd) = self.mini_hwnd() {
            native::hide(hwnd);
        }
        self.mini_runtime = MiniRuntime::default();
        self.cancel_mini_restore();
        self.mini_last_snapshot = None;
        self.mini_feed_logged = false;
        self.mini_drag_offset = None;
        let pet_size = self.mini_host.pet_size;
        self.mini_host = MiniHost::new(self.profile.clone());
        self.mini_host.pet_size = pet_size;
        let config = &self.config.mini;
        self.mini_host.pet = config.pet;
        self.mini_host.locked = config.locked;
        self.mini_host.always_on_top = config.always_on_top;
        self.mini_host.auto_on_main_hidden = config.auto_on_main_hidden;
        self.mini_host.geometry = config.geometry.clone();
        self.mini_host.scale = config.scale;
        *self.mini_cover.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.mini_eval("window.hertzMini && window.hertzMini.resetInteraction();");
        self.mini_send_snapshot();
        self.mini_send_cover();
        self.mini_send_config();
        if !config::is_dbx(&self.profile) {
            spawn_mini_feed(
                self.profile.clone(),
                self.proxy.clone(),
                self.source_generation,
                self.mini_runtime.clone(),
            );
            if self.config.mini.reopen {
                let action = self
                    .mini_host
                    .handle(MiniEvent::Enter(crate::mini::EnterReason::Restored));
                self.apply_mini_action(action, target);
            }
        }
    }

    fn show_mini_context_menu(&mut self) {
        let Some(hwnd) = self.mini_hwnd() else { return };
        let menu = Menu::new();
        let restore = MenuItem::with_id("mini-context-restore", "回到主窗口", true, None);
        let topmost = CheckMenuItem::with_id(
            "mini-context-topmost",
            "始终置顶",
            true,
            self.config.mini.always_on_top,
            None,
        );
        let pet = CheckMenuItem::with_id(
            "mini-context-pet",
            "宠物形态",
            true,
            self.config.mini.pet,
            None,
        );
        let edge = CheckMenuItem::with_id(
            "mini-context-edge-hide",
            "贴边隐藏",
            true,
            self.config.mini.edge_hide,
            None,
        );
        let locked = CheckMenuItem::with_id(
            "mini-context-lock",
            "锁定位置",
            self.tray.is_some(),
            self.config.mini.locked,
            None,
        );
        let quit = MenuItem::with_id("mini-context-quit", "关闭桌面宠物", true, None);
        if let Err(error) = menu.append_items(&[
            &restore,
            &topmost,
            &pet,
            &edge,
            &locked,
            &PredefinedMenuItem::separator(),
            &quit,
        ]) {
            log(&format!("mini context menu failed: {error}"));
            return;
        }
        // 原生弹出菜单独立于 56px WebView 的裁切区；保留句柄直到菜单事件消费。
        unsafe {
            menu.show_context_menu_for_hwnd(hwnd as isize, None);
        }
        self.mini_context_menu = Some(menu);
    }

    /// 状态机的动作落到窗口。mini.rs 只出意图，HWND 的活全在这。
    fn apply_mini_action(&mut self, action: MiniAction, target: &EventLoopWindowTarget<()>) {
        match action {
            MiniAction::None => {}
            MiniAction::Show => {
                if self.ensure_mini(target) {
                    if let Some(hwnd) = self.mini_hwnd() {
                        native::show_no_activate(hwnd);
                    }
                    self.place_mini();
                    if let Some(hwnd) = self.mini_hwnd() {
                        self.mini_host.push_window_style(hwnd as isize);
                    }
                    self.mini_send_all();
                    self.sync_tray();
                }
            }
            MiniAction::Hide => {
                self.cancel_mini_restore();
                if let Some(hwnd) = self.mini_hwnd() {
                    native::hide(hwnd);
                }
                self.sync_tray();
            }
            MiniAction::Place => {
                self.place_mini();
                self.mini_send_config();
            }
            MiniAction::ApplyWindowStyle => {
                if let Some(hwnd) = self.mini_hwnd() {
                    self.mini_host.push_window_style(hwnd as isize);
                }
                self.mini_send_config();
            }
            MiniAction::NotifyRestore => {
                self.mini_request_restore();
            }
        }
        self.mini_sync_runtime();
    }

    /// 按需创建小窗。返回 false 表示创建失败（已记日志），状态机保持现状。
    fn ensure_mini(&mut self, target: &EventLoopWindowTarget<()>) -> bool {
        if self.mini.is_some() {
            return true;
        }
        match create_mini(target, self.proxy.clone(), self.mini_cover.clone()) {
            Ok(surface) => {
                // 必须在 WebView 建好之后再装命中处理：WebView2 的子窗那时才存在，
                // 而它才是 WM_NCHITTEST 的第一到达点（设计 §6.2）。
                mini_native::install(surface.hwnd);
                self.mini = Some(surface);
                self.mini_page_ready = false;
                self.mini_skin_signature = self.pet_skin_signature();
                true
            }
            Err(error) => {
                log(&format!("mini window unavailable: {error:#}"));
                false
            }
        }
    }

    fn place_mini(&mut self) {
        let Some(surface) = self.mini.as_ref() else {
            return;
        };
        let dpi = native::window_dpi(surface.hwnd).max(1);
        let Some((x, y, width, height)) = self.mini_host.desired_rect(dpi) else {
            return;
        };
        // 拖拽期间位置归拖拽线程管，place 只负责尺寸（Peeking 拖出时要恢复整窗）。
        let (x, y) = if self.mini_host.phase == MiniPhase::Dragging {
            self.mini_host
                .rect
                .map(|(cx, cy, _, _)| (cx, cy))
                .unwrap_or((x, y))
        } else {
            (x, y)
        };
        mini_native::move_window(surface.hwnd, x, y, width, height);
        self.mini_host.rect = Some((x, y, width, height));
    }

    fn mini_send_all(&self) {
        self.mini_send_config();
        self.mini_send_snapshot();
        self.mini_send_cover();
    }

    fn mini_send_config(&self) {
        let mini = &self.config.mini;
        let payload = serde_json::json!({
            "theme": "auto",
            "scale": mini.scale,
            "opacity": mini.opacity,
            "sung": self.config.lyrics.sung_color.as_str(),
            "pet": mini.pet,
            "locked": mini.locked,
            "topmost": mini.always_on_top,
            "edgeHide": mini.edge_hide,
            "dock": self.mini_host.geometry.dock.label(),
            "peek": self.mini_host.phase == MiniPhase::Peeking,
        });
        self.mini_eval(&format!(
            "window.hertzMini && window.hertzMini.applyConfig({payload});"
        ));
    }

    fn mini_send_snapshot(&self) {
        let Some(snapshot) = self.mini_last_snapshot.as_ref() else {
            self.mini_eval("window.hertzMini && window.hertzMini.applySnapshot(null);");
            return;
        };
        let payload = serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null);
        self.mini_eval(&format!(
            "window.hertzMini && window.hertzMini.applySnapshot({payload});"
        ));
    }

    fn mini_send_position(&self, ms: u64) {
        if self.mini_host.phase == MiniPhase::Hidden {
            return;
        }
        let duration = self
            .mini_last_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.duration_ms);
        let payload = serde_json::json!({ "ms": ms, "durationMs": duration });
        self.mini_eval(&format!(
            "window.hertzMini && window.hertzMini.applyPosition({payload});"
        ));
    }

    fn mini_send_cover(&self) {
        let guard = self
            .mini_cover
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let script = match guard.as_ref() {
            // 相对 URL：页面实际跑在 http://hertz.localhost/（wry 的自定义协议
            // 映射），绝对 hertz:// 形式不匹配资源拦截过滤器，img 会静默失败。
            Some((version, _, _)) => format!(
                "window.hertzMini && window.hertzMini.applyCover('mini-cover?v={version}');"
            ),
            None => "window.hertzMini && window.hertzMini.applyCover(null);".to_string(),
        };
        drop(guard);
        self.mini_eval(&script);
    }

    /// 页面 ⇄ 宿主的可见性/节奏开关。线程读共享量，不认识相位。
    fn mini_sync_runtime(&self) {
        let visible = self.mini_host.phase != MiniPhase::Hidden && self.mini.is_some();
        self.mini_runtime.visible.store(visible, Ordering::Relaxed);
        let playing = self
            .mini_last_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.playing);
        let hint = if self.mini_restore_pending.is_some() {
            250
        } else if !visible {
            5000
        } else if playing {
            500
        } else {
            2000
        };
        self.mini_runtime
            .poll_hint_ms
            .store(hint, Ordering::Relaxed);
    }

    fn handle_mini_feed(
        &mut self,
        started: Instant,
        result: Result<MiniUpdate, String>,
        target: &EventLoopWindowTarget<()>,
    ) {
        if started.elapsed() >= STALE_AFTER {
            return;
        }
        match result {
            Err(message) => {
                // 同一条错误只记一次，别让 500ms 轮询刷爆日志。
                if std::mem::replace(&mut self.mini_feed_logged, true) {
                    return;
                }
                log(&format!("mini feed: {message}"));
            }
            Ok(update) => {
                self.mini_feed_logged = false;
                let previous = self
                    .mini_last_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.main.visible);
                let visible_now = update.snapshot.main.visible;
                // 主窗口回前台：自动接管的那次要收回去；主窗口藏了：到点自动接管。
                if visible_now
                    && self
                        .mini_restore_pending
                        .as_ref()
                        .is_some_and(|request| request.ready)
                    && native::main_browser_is_foreground(&update.snapshot.main.window_title)
                {
                    self.cancel_mini_restore();
                    let action = self.mini_host.handle(MiniEvent::RestoreComplete);
                    self.apply_mini_action(action, target);
                    self.config.mini.reopen = false;
                    self.schedule_save();
                } else if previous == Some(false)
                    && visible_now
                    && self.mini_restore_pending.is_none()
                {
                    let action = self.mini_host.handle(MiniEvent::MainVisible);
                    self.apply_mini_action(action, target);
                } else if !visible_now && previous != Some(false) {
                    let action = self
                        .mini_host
                        .handle(MiniEvent::Enter(crate::mini::EnterReason::MainHidden));
                    self.apply_mini_action(action, target);
                }
                let old_cover = self
                    .mini_last_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.track.as_ref())
                    .and_then(|track| track.cover_key.as_ref());
                let new_cover = update
                    .snapshot
                    .track
                    .as_ref()
                    .and_then(|track| track.cover_key.as_ref());
                let cover_changed = old_cover != new_cover;
                self.mini_last_snapshot = Some(update.snapshot);
                self.mini_send_snapshot();
                if let Some(bytes) = update.cover {
                    let mime = sniff_image_mime(&bytes).to_string();
                    let mut guard = self
                        .mini_cover
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    self.mini_cover_version += 1;
                    *guard = Some((self.mini_cover_version, bytes, mime));
                    drop(guard);
                    self.mini_send_cover();
                } else if cover_changed {
                    *self
                        .mini_cover
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = None;
                    self.mini_send_cover();
                }
                self.mini_sync_runtime();
            }
        }
    }

    /// 小窗页面的 IPC。与歌词页的 page_command 平行，互不复用：
    /// 命令集不同、容错策略不同（小窗卡住比崩掉好）。
    fn mini_page_command(&mut self, body: &str, target: &EventLoopWindowTarget<()>) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Command {
            cmd: String,
            #[serde(default)]
            regions: Vec<(f64, f64, f64, f64)>,
            #[serde(default)]
            offset_x: Option<f64>,
            #[serde(default)]
            offset_y: Option<f64>,
            #[serde(default)]
            action: Option<String>,
            #[serde(default)]
            item: Option<String>,
            #[serde(default)]
            on: Option<bool>,
            #[serde(default)]
            width: Option<f64>,
            #[serde(default)]
            height: Option<f64>,
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            log("ignore malformed mini page command");
            return;
        };
        match command.cmd.as_str() {
            "ready" => {
                self.mini_page_ready = true;
                self.mini_send_all();
            }
            "context-menu" => self.show_mini_context_menu(),
            "hit-regions" => {
                self.mini_host.set_hit_regions(command.regions.clone());
                if let Some(hwnd) = self.mini_hwnd() {
                    let dpi = native::window_dpi(hwnd).max(1);
                    mini_native::set_hit_regions(hwnd, &command.regions, dpi);
                }
            }
            "drag-begin" => {
                let (Some(offset_x), Some(offset_y)) = (command.offset_x, command.offset_y) else {
                    return;
                };
                self.mini_drag_offset = Some((offset_x.round() as i32, offset_y.round() as i32));
                let action = self.mini_host.handle(MiniEvent::DragBegin);
                self.apply_mini_action(action, target);
                if let Some(hwnd) = self.mini_hwnd() {
                    let proxy = self.proxy.clone();
                    let generation = self.source_generation;
                    mini_native::begin_drag(hwnd, move |event| {
                        let _ = proxy.send_event(UserEvent::MiniDrag(generation, event));
                    });
                }
            }
            "restore" => {
                let action = self.mini_host.handle(MiniEvent::Restore);
                self.apply_mini_action(action, target);
                self.sync_tray();
            }
            "control" => {
                let Some(action) = command.action.filter(|action| {
                    matches!(
                        action.as_str(),
                        "play" | "pause" | "toggle" | "next" | "previous"
                    )
                }) else {
                    return;
                };
                self.mini_control(&action);
            }
            "menu" => self.mini_menu(command.item.as_deref(), command.on, target),
            "quit" => {
                self.cancel_mini_restore();
                let action = self.mini_host.handle(MiniEvent::Quit);
                self.apply_mini_action(action, target);
                self.config.mini.reopen = false;
                self.schedule_save();
                self.sync_tray();
            }
            // 页面加载皮肤后上报逻辑尺寸：宠物收起态的窗体形状跟素材走。
            "pet-size" => {
                let (Some(width), Some(height)) = (command.width, command.height) else {
                    return;
                };
                if self.mini_host.set_pet_size(width, height) {
                    self.place_mini();
                }
            }
            // 悬停展开/收起。Peeking/Hidden 下无效（窗可能整块穿透，事件本来也收不到）。
            "pet-hover" => {
                let on = command.on.unwrap_or(false)
                    && self.mini_host.phase != MiniPhase::Peeking
                    && self.mini_host.phase != MiniPhase::Hidden;
                if self.mini_host.pet_hover != on {
                    self.mini_host.pet_hover = on;
                    self.place_mini();
                }
            }
            _ => {}
        }
    }

    fn mini_menu(
        &mut self,
        item: Option<&str>,
        on: Option<bool>,
        target: &EventLoopWindowTarget<()>,
    ) {
        let Some(item) = item else { return };
        match item {
            "restore" => {
                let action = self.mini_host.handle(MiniEvent::Restore);
                self.apply_mini_action(action, target);
                self.sync_tray();
                return;
            }
            "quit" => {
                self.cancel_mini_restore();
                let action = self.mini_host.handle(MiniEvent::Quit);
                self.apply_mini_action(action, target);
                self.config.mini.reopen = false;
                self.schedule_save();
                self.sync_tray();
                return;
            }
            // 下面四项都是开关，on 缺省按「取反现值」处理不可靠，直接忽略。
            "topmost" | "pet" | "edge-hide" | "lock" => {}
            _ => return,
        }
        let Some(on) = on else { return };
        match item {
            "topmost" => {
                self.config.mini.always_on_top = on;
                self.mini_host.always_on_top = on;
            }
            "pet" => {
                self.config.mini.pet = on;
                self.mini_host.pet = on;
                if !on {
                    self.mini_host.pet_hover = false;
                }
            }
            "edge-hide" => {
                self.config.mini.edge_hide = on;
            }
            "lock" => {
                self.config.mini.locked = on;
                self.mini_host.locked = on;
            }
            _ => {}
        }
        self.config.sanitize();
        // 置顶/穿透即刻生效（走状态机动作，别绕过 push_window_style 的唯一入口）。
        self.apply_mini_action(MiniAction::ApplyWindowStyle, target);
        // 宠物开关会改窗体尺寸；贴边隐藏的相位也要对齐。
        let cursor_inside = self.mini_hwnd().is_some_and(mini_native::cursor_in_window);
        let action = self
            .mini_host
            .tick_peek(self.config.mini.edge_hide, cursor_inside);
        self.apply_mini_action(action, target);
        self.place_mini();
        self.schedule_save();
        self.sync_tray();
    }

    fn mini_control(&mut self, action: &str) {
        let Some(snapshot) = self.mini_last_snapshot.as_ref() else {
            return;
        };
        let payload = serde_json::json!({
            "action": action,
            "session": snapshot.server.session,
            "generation": snapshot.generation,
        });
        let profile = self.profile.clone();
        let proxy = self.proxy.clone();
        let generation = self.source_generation;
        std::thread::spawn(move || {
            let result = crate::mini_feed::MiniFeed::new(profile)
                .and_then(|feed| feed.control(&payload))
                .map_err(|error| format!("{error:#}"));
            let _ = proxy.send_event(UserEvent::MiniControl(generation, result));
        });
    }

    fn cancel_mini_restore(&mut self) {
        if let Some(request) = self.mini_restore_pending.take() {
            request.cancelled.store(true, Ordering::Relaxed);
        }
    }

    /// 广播 DOM 展开并恢复浏览器；实际可见且在前台后才收起小窗。
    fn mini_request_restore(&mut self) {
        if self.mini_restore_pending.is_some() {
            return;
        }
        let Some(snapshot) = self.mini_last_snapshot.as_ref() else {
            return;
        };
        let payload = serde_json::json!({
            "action": "restore",
            "session": snapshot.server.session,
        });
        let profile = self.profile.clone();
        let proxy = self.proxy.clone();
        let generation = self.source_generation;
        let title = snapshot.main.window_title.clone();
        let stop = self.mini_runtime.stop.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.mini_restore_pending = Some(MiniRestoreRequest {
            started: Instant::now(),
            cancelled: cancelled.clone(),
            ready: false,
        });
        self.mini_runtime.poll_hint_ms.store(250, Ordering::Relaxed);
        let restored = native::restore_main_browser(&title);
        std::thread::spawn(move || {
            let result = crate::mini_feed::MiniFeed::new(profile.clone())
                .and_then(|feed| {
                    if stop.load(Ordering::Relaxed) || cancelled.load(Ordering::Relaxed) {
                        bail!("恢复请求已取消");
                    }
                    feed.control(&payload)?;
                    if stop.load(Ordering::Relaxed) || cancelled.load(Ordering::Relaxed) {
                        bail!("恢复请求已取消");
                    }
                    if !restored {
                        let discovery = crate::bridge::read_discovery(&profile)?;
                        if stop.load(Ordering::Relaxed)
                            || cancelled.load(Ordering::Relaxed)
                            || discovery.server_instance_id.as_deref()
                                != payload["session"].as_str()
                        {
                            bail!("播放来源已切换");
                        }
                        native::open_url(&format!("http://127.0.0.1:{}/", discovery.port))?;
                    }
                    Ok(())
                })
                .map_err(|error| format!("{error:#}"));
            let _ = proxy.send_event(UserEvent::MiniRestore(generation, cancelled, result));
        });
    }

    /// 松手后把吸附/自由位置写回配置（设计 §2：只在 DragEnd 落盘）。
    fn mini_save_geometry(&mut self) {
        self.config.mini.geometry = self.mini_host.geometry.clone();
        self.config.mini.reopen = true;
        self.schedule_save();
        self.mini_send_config();
    }

    fn mini_drag_move(&mut self, x: i32, y: i32) {
        let Some(surface) = self.mini.as_ref() else {
            return;
        };
        let Some((offset_x, offset_y)) = self.mini_drag_offset else {
            return;
        };
        let dpi = native::window_dpi(surface.hwnd).max(1);
        let scale = f64::from(dpi) / 96.0;
        let Some((_, _, width, height)) = self.mini_host.rect else {
            return;
        };
        let mut nx = x - (f64::from(offset_x) * scale).round() as i32;
        let mut ny = y - (f64::from(offset_y) * scale).round() as i32;
        // 拖出界外贴住工作区，别让窗跑丢（与歌词的 bounded_lyrics_position 同款）。
        if let Some(area) = self.mini_host.target_area() {
            let (bx, by) = crate::mini::bounded_position(nx, ny, width, height, &area);
            nx = bx;
            ny = by;
        }
        mini_native::move_window(surface.hwnd, nx, ny, width, height);
        self.mini_host.rect = Some((nx, ny, width, height));
    }

    /// 桌宠素材目录的指纹：浅层文件的（名字, 大小, mtime 纳秒）哈希。
    /// 目录不存在返回 None；只在内存里与上一次比较，不落盘。
    fn pet_skin_signature(&self) -> Option<u64> {
        use std::hash::{Hash, Hasher};
        let entries = std::fs::read_dir(config::base_dir().join("pet")).ok()?;
        let mut files: Vec<(String, u64, u64)> = Vec::new();
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos() as u64)
                .unwrap_or(0);
            files.push((
                entry.file_name().to_string_lossy().into_owned(),
                metadata.len(),
                modified,
            ));
        }
        files.sort();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for (name, len, modified) in &files {
            name.hash(&mut hasher);
            len.hash(&mut hasher);
            modified.hash(&mut hasher);
        }
        Some(hasher.finish())
    }

    /// 打开（并初始化）桌宠素材文件夹。约定见 PET_ASSETS_README。
    fn open_pet_assets(&mut self) {
        let dir = config::base_dir().join("pet");
        if let Err(error) = std::fs::create_dir_all(&dir) {
            log(&format!("create pet dir failed: {error:#}"));
            return;
        }
        let readme = dir.join("README.txt");
        if !readme.exists() {
            let _ = std::fs::write(&readme, PET_ASSETS_README);
        }
        match std::process::Command::new("explorer").arg(&dir).spawn() {
            Ok(_) => log("opened pet assets folder"),
            Err(error) => log(&format!("open pet assets folder failed: {error:#}")),
        }
    }

    fn cancel_calibration(&mut self) {
        if let Some(pending) = self.calibration_pending.take() {
            pending.cancel(self.profile.clone());
            self.eval(
                "window.hertzLyrics && window.hertzLyrics.calibrationDone({state:'cancelled'});",
            );
        }
    }
    fn start_calibration(&mut self) {
        if self.calibration_pending.is_some() {
            return;
        }
        let reason = if self.policy.locked {
            Some("locked")
        } else if !self.lyrics_running() {
            Some("receiver-unavailable")
        } else if self.last_update.elapsed() >= STALE_AFTER {
            Some("source-stale")
        } else if let Some(snapshot) = &self.last_snapshot {
            if snapshot.track.is_none() {
                Some("track-changed")
            } else if snapshot.lyrics.status != "ready" {
                Some("lyrics-unavailable")
            } else if let Some(capability) = &snapshot.lyrics_calibration {
                if capability["version"] != 1 {
                    Some("capability-unavailable")
                } else if capability["available"] != true {
                    Some(
                        capability["reason"]
                            .as_str()
                            .unwrap_or("receiver-unavailable"),
                    )
                } else {
                    None
                }
            } else {
                Some("capability-unavailable")
            }
        } else {
            Some("receiver-unavailable")
        };
        if let Some(reason) = reason {
            self.eval(&format!(
                "window.hertzLyrics.calibrationDone({});",
                serde_json::json!({"state":reason})
            ));
            return;
        }
        let Some(pending) = self
            .last_snapshot
            .as_ref()
            .and_then(crate::calibration::Pending::new)
        else {
            self.eval("window.hertzLyrics.calibrationDone({state:'track-changed'});");
            return;
        };
        let profile = self.profile.clone();
        let proxy = self.proxy.clone();
        let source_generation = self.source_generation;
        let id = pending.id.clone();
        let worker = pending.clone();
        self.calibration_pending = Some(pending);
        std::thread::spawn(move || {
            let result = crate::calibration::run(profile, worker);
            let _ = proxy.send_event(UserEvent::LyricCalibration(source_generation, id, result));
        });
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
        if self.position_edit.is_some()
            && !matches!(
                command.cmd.as_str(),
                "ready" | "clock" | "drag" | "log" | "vocal-measure"
            )
        {
            return;
        }
        match command.cmd.as_str() {
            "calibrate" => self.start_calibration(),
            "calibration-cancel" => self.cancel_calibration(),
            "clock" => {
                self.page_clock = command.value.and_then(PageClock::new);
            }
            "ready" => {
                self.page_clock = command.value.and_then(PageClock::new);
                self.page_ready = true;
                *self.lyrics_geometry_payload.borrow_mut() = None;
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
            "play" | "pause" | "seek" => {
                let (Some(profile), Some(snapshot)) = (
                    self.config.active_profile.clone(),
                    self.last_snapshot.as_ref(),
                ) else {
                    return;
                };
                if config::is_dbx(&profile)
                    || self.policy.locked
                    || self.last_update.elapsed() > Duration::from_secs(2)
                {
                    return;
                }
                let Some(track) = snapshot.track.as_ref() else {
                    return;
                };
                let payload = serde_json::json!({
                    "action": command.cmd,
                    "session": snapshot.server.session,
                    "trackId": track.id,
                    "generation": snapshot.generation,
                    "documentKey": snapshot.lyrics.document_key,
                    "positionMs": command.value.filter(|v| v.is_finite() && *v >= 0.0).map(|v| v as u64),
                });
                let proxy = self.proxy.clone();
                let generation = self.source_generation;
                std::thread::spawn(move || {
                    let result =
                        crate::feed::control(&profile, &payload).map_err(|e| format!("{e:#}"));
                    let _ = proxy.send_event(UserEvent::LyricControl(generation, result));
                });
            }
            "appearance" => {
                let Some(target) = command.target.as_deref() else {
                    return;
                };
                if !matches!(
                    target,
                    "theme"
                        | "surface"
                        | "align"
                        | "bilingual"
                        | "showVocals"
                        | "karaoke"
                        | "readabilityBoost"
                        | "fontSize"
                        | "opacity"
                ) {
                    return;
                }
                let value = match target {
                    "bilingual" | "showVocals" | "karaoke" | "readabilityBoost" => {
                        match command.text.as_deref() {
                            Some("true") => serde_json::Value::Bool(true),
                            Some("false") => serde_json::Value::Bool(false),
                            _ => return,
                        }
                    }
                    "fontSize" | "opacity" => {
                        let Some(value) = command.value.filter(|v| v.is_finite()) else {
                            return;
                        };
                        serde_json::json!(value)
                    }
                    _ => serde_json::json!(command.text),
                };
                let mut updated = serde_json::to_value(&self.config.lyrics).unwrap();
                updated[target] = value;
                let Ok(lyrics) = serde_json::from_value::<config::LyricsConfig>(updated) else {
                    return;
                };
                self.config.lyrics = lyrics;
                self.config.sanitize();
                self.send_config();
                self.place(true);
                self.schedule_save();
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
                    self.mini_send_config();
                    self.schedule_save();
                }
            }
            "panel" => {
                if let Some(height) = command.value {
                    self.set_panel_height(height);
                }
            }
            "vocal-measure" => {
                if self.vocal_document_mode()
                    && command.text.as_deref() == self.current_document_key.as_deref()
                    && command.target.as_deref() == Some(self.lyrics_font_key().as_str())
                {
                    if let Some(height) = command.value.filter(|height| height.is_finite()) {
                        let height = height.clamp(0.0, 1024.0).ceil();
                        let font = self.lyrics_font_key();
                        if self.lyrics_measure_font.as_deref() != Some(font.as_str())
                            || height > self.lyrics_measured_slot
                        {
                            self.lyrics_measure_font = Some(font);
                            self.lyrics_measured_slot = height;
                            self.place(true);
                        }
                    }
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
            "fit" => {
                if let Some(required) = command.value {
                    self.set_fitted_width(required);
                }
            }
            "quit" | "lyrics-exit" => {
                self.exit_feature(feature_exit::Feature::Lyrics);
            }
            "log" => {
                if let Some(text) = command.text {
                    log(&format!("page: {text}"));
                }
            }
            other => log(&format!("unknown page command: {other}")),
        }
    }

    fn handle_menu(&mut self, id: &str, target: &EventLoopWindowTarget<()>) {
        if let Some(item) = id.strip_prefix("mini-context-") {
            let on = match item {
                "topmost" => Some(!self.config.mini.always_on_top),
                "pet" => Some(!self.config.mini.pet),
                "edge-hide" => Some(!self.config.mini.edge_hide),
                "lock" => Some(!self.config.mini.locked),
                _ => None,
            };
            self.mini_menu(Some(item), on, target);
            return;
        }
        let Some(actions) = self.tray_actions.as_ref() else {
            return;
        };
        if self.position_edit.is_some()
            && id != actions.settings_id
            && id != actions.locate_id
            && id != actions.quit_id
            && id != actions.lyrics_exit_id
            && id != actions.wallpaper_exit_id
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
        } else if id == actions.mini_toggle_id {
            // 托盘开关：勾上 = 进入小窗（宠物态由配置里的 pet 决定），去掉 = 退出。
            let action = if self.mini_host.phase == MiniPhase::Hidden {
                self.mini_host
                    .handle(MiniEvent::Enter(crate::mini::EnterReason::User))
            } else {
                self.mini_host.handle(MiniEvent::Quit)
            };
            self.apply_mini_action(action, target);
            self.config.mini.reopen = self.mini_host.phase != MiniPhase::Hidden;
            self.schedule_save();
            self.sync_tray();
        } else if id == actions.mini_assets_id {
            self.open_pet_assets();
        } else if id == actions.lyrics_exit_id {
            self.exit_feature(feature_exit::Feature::Lyrics);
        } else if id == actions.wallpaper_exit_id {
            self.exit_feature(feature_exit::Feature::Wallpaper);
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
        target: &EventLoopWindowTarget<()>,
    ) -> serde_json::Value {
        if !crate::management::is_versioned(request) {
            return self.handle_pipe_command(request, target, None);
        }
        let v2 = match crate::management::parse(request) {
            Ok(request) => request,
            Err(response) => return response,
        };
        let response = match v2
            .check_target(self.config.active_profile.as_ref())
            .and_then(|()| v2.check_value(self.config.revision, self.save_due.is_some()))
        {
            Ok(()) => self.handle_pipe_command(request, target, Some(&v2)),
            Err(error) => error,
        };
        let response = if response["ok"] == true {
            self.with_target_status(response, Some(&v2.target_profile))
        } else {
            response
        };
        crate::management::reply(response, Some(&v2.request_id))
    }

    fn handle_pipe_command(
        &mut self,
        request: &serde_json::Value,
        target: &EventLoopWindowTarget<()>,
        v2: Option<&crate::management::Request>,
    ) -> serde_json::Value {
        let command = request
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        log(&format!("control command={command}"));
        let value = request.get("value");
        if v2.is_none()
            && config::is_dbx(&self.profile)
            && !matches!(
                command,
                "status" | "wallpaper-status" | "wallpaper-settings" | "open-center"
            )
        {
            return pipe_error_detail(
                "source_target_required",
                "此来源需要带明确目标的桌面管理协议",
            );
        }
        if self.position_edit.is_some()
            && !matches!(
                command,
                "status"
                    | "wallpaper-status"
                    | "wallpaper-settings"
                    | "open-center"
                    | "quit"
                    | "lyrics-exit"
                    | "wallpaper-exit"
            )
        {
            return pipe_error_detail(
                "position_edit_active",
                "请在桌面歌词与壁纸设置中完成或取消位置调整",
            );
        }
        match command {
            "status" | "wallpaper-status" => {}
            "lyrics-exit" | "wallpaper-exit" => {
                if value.is_some_and(|value| {
                    !value.is_null() && value.as_object().is_none_or(|object| !object.is_empty())
                }) {
                    return pipe_error("invalid_value");
                }
                return self.exit_feature(if command == "lyrics-exit" {
                    feature_exit::Feature::Lyrics
                } else {
                    feature_exit::Feature::Wallpaper
                });
            }
            "wallpaper-settings" | "open-center" => {
                if self.embedded && self.settings_events.is_none() {
                    return pipe_error("请在桌面主程序内打开壁纸设置");
                }
                if let Some(tab) = value
                    .and_then(|value| value.get("tab"))
                    .and_then(|tab| tab.as_str())
                    .filter(|tab| matches!(*tab, "wallpaper" | "lyrics" | "runtime"))
                {
                    self.settings_tab = tab.to_string();
                    self.settings_navigation = self.settings_navigation.wrapping_add(1);
                }
                // Legacy callers may open the current DBX center, but cannot nominate
                // another source through the unscoped management envelope.
                if let Some(v2) = v2 {
                    self.settings_candidate = Some(v2.target_profile.clone());
                } else if !config::is_dbx(&self.profile) {
                    if let Some(profile) = value
                        .and_then(|value| value.get("profile"))
                        .and_then(|value| config::management_profile(value.clone()).ok())
                        .and_then(|profile| config::normalize_profile(profile).ok())
                    {
                        self.settings_candidate = Some(profile);
                    }
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
            "mini-toggle" => {
                // DBX/Web 宿主走页内胶囊：小窗需要本机 HTTP 窄凭据，DBX 没有通道。
                if config::is_dbx(&self.profile) {
                    return pipe_error_detail(
                        "unsupported_source",
                        "DBX 形态不支持小窗播放，请使用页内胶囊",
                    );
                }
                let action = if self.mini_host.phase == MiniPhase::Hidden {
                    self.mini_host
                        .handle(MiniEvent::Enter(crate::mini::EnterReason::User))
                } else {
                    self.mini_host.handle(MiniEvent::Quit)
                };
                self.apply_mini_action(action, target);
                self.config.mini.reopen = self.mini_host.phase != MiniPhase::Hidden;
                self.schedule_save();
                self.sync_tray();
            }
            "open-pet-assets" => {
                if config::is_dbx(&self.profile) {
                    return pipe_error_detail("unsupported_source", "DBX 形态没有桌面宠物素材目录");
                }
                self.open_pet_assets();
            }
            "wallpaper-retry" => self.retry_wallpaper(target),
            "wallpaper-preview-close" => self.close_preview(),
            "wallpaper-preview-renew" => self.renew_preview(None),
            "wallpaper-preview" => {
                if self.library_delete.is_some() {
                    return pipe_error_detail(
                        "asset_in_use",
                        "正在删除作品，请等待完成后再预览壁纸",
                    );
                }
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
                if self.library_delete.is_some() {
                    return pipe_error_detail(
                        "asset_in_use",
                        "正在删除作品，请等待完成后再应用壁纸",
                    );
                }
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
                    profile: serde_json::Value,
                }
                let switch = match serde_json::from_value::<SwitchRequest>(
                    value.cloned().unwrap_or(serde_json::Value::Null),
                ) {
                    Ok(switch) => switch,
                    Err(_) => return pipe_error("invalid_value"),
                };
                let profile = match config::management_profile(switch.profile) {
                    Ok(profile) if !config::is_dbx(&profile) => profile,
                    _ => return pipe_error("source_target_required"),
                };
                if let Err(error) = self.switch_source(profile, switch.expected_revision, target) {
                    return pipe_error_detail("profile_switch_failed", error);
                }
            }
            "lock" => {
                // 锁定后要有解锁入口：独立形态靠自己的托盘，内嵌形态靠播放器托盘。
                if !self.can_lock_lyrics() {
                    return pipe_error("tray_unavailable");
                }
                self.set_locked(true);
            }
            "unlock" => self.set_locked(false),
            "show" => {
                if !self.config.lyrics.enabled {
                    self.schedule_save();
                }
                self.config.lyrics.enabled = true;
                self.resume_lyrics();
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
                    Some("triple") => Layout::Triple,
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

    fn with_target_status(
        &self,
        mut response: serde_json::Value,
        target: Option<&Profile>,
    ) -> serde_json::Value {
        let is_active = target
            .zip(self.config.active_profile.as_ref())
            .is_some_and(|(target, active)| config::same_profile(target, active));
        let scopes = self.source_health.scopes(is_active, Instant::now());
        response["targetProfile"] = serde_json::to_value(target).unwrap();
        response["sourceConnected"] =
            (scopes["lyrics"] == true || scopes["wallpaper"] == true).into();
        response["sourceScopes"] = scopes;
        response["sourceSession"] = self.source_health.session().into();
        response
    }

    fn status_json(&self) -> serde_json::Value {
        let idle = wallpaper_runtime::DesktopRuntime::new(
            self.config.wallpaper.clone(),
            self.config.revision,
            None,
            false,
        );
        let mut value = self.status_for_desktop(
            self.desktop
                .runtimes
                .values()
                .find(|runtime| {
                    !runtime.closing
                        && runtime.configuration.main().id == self.config.wallpaper.main().id
                })
                .unwrap_or(&idle),
        );
        value["wallpaper"]["targets"] = self
            .desktop
            .runtimes
            .iter()
            .map(|(key, desktop)| {
                let mut status = self.status_for_desktop(desktop);
                let mut target = status["wallpaper"].take();
                target["diagnostics"] = status["diagnostics"].take();
                target["targetId"] = key.clone().into();
                target["groupId"] = desktop.configuration.main().id.clone().into();
                target["desiredRevision"] = desktop.desired_revision.into();
                target["state"] = (if desktop.closing {
                    "stopped"
                } else if !self.wallpaper_target_running(&desktop.configuration) {
                    "disabled"
                } else if desktop.monitor_missing {
                    "missing"
                } else if desktop.application_gate.stable()
                    == Some(crate::wallpaper::config::RuleAction::Stop)
                {
                    "stopped"
                } else if desktop.apply_error.is_some() {
                    "failed"
                } else if desktop.visible {
                    "running"
                } else if desktop
                    .handoff
                    .as_ref()
                    .is_some_and(|handoff| handoff.pause_retained)
                {
                    "paused"
                } else if desktop.candidate.is_some()
                    || desktop.prepared.is_some()
                    || desktop.selection.is_some()
                {
                    "preparing"
                } else if desktop.surface.is_some() {
                    "paused"
                } else {
                    "preparing"
                })
                .into();
                if let Some(object) = target.as_object_mut() {
                    for shared in [
                        "budget",
                        "mediaPreview",
                        "previewLease",
                        "previewActive",
                        "mediaPreviewAvailable",
                        "decodeProbe",
                        "retirements",
                        "retiringControllers",
                        "retiringHandoffs",
                        "audio",
                        "settingsOpen",
                    ] {
                        object.remove(shared);
                    }
                }
                target
            })
            .collect::<Vec<_>>()
            .into();
        value["wallpaper"]["topology"] =
            serde_json::to_value(self.desktop.topology.current()).expect("display plan");
        value["wallpaper"]["globalRecoveryTerminal"] = self
            .desktop
            .recovery
            .is_terminal(crate::wallpaper::session::FaultDomain::Global)
            .into();
        value
    }

    fn status_for_desktop(&self, desktop: &wallpaper_runtime::DesktopRuntime) -> serde_json::Value {
        let pause_inputs = policy::PolicyInputs {
            enabled: self.wallpaper_target_running(&desktop.configuration),
            wallpaper: &desktop.configuration,
            manual_pause: self.wallpaper_hidden,
            fullscreen: desktop.fullscreen_gate.stable(),
            maximized: desktop.maximized_gate.stable(),
            application_rule: desktop.application_gate.stable(),
            session_unavailable: self.policy.session_unavailable,
            display_off: self.policy.display_off,
            display_missing: desktop.monitor_missing,
            power: self.wallpaper_power,
            has_surface: desktop.surface.is_some(),
            page_ready: desktop.page_ready,
        };
        let (divisor, budget) = frame_divisor(
            desktop.configuration.presentation().fps,
            desktop
                .surface
                .as_ref()
                .map(|surface| surface.monitor.refresh_hz)
                .unwrap_or(0),
        );
        let media_status = desktop.surface.as_ref().and_then(|surface| surface.session.media()).map(|media| serde_json::json!({
            "kind": if media.input().metadata.container == crate::wallpaper::media::Container::Image { "image" } else { "video" },
            "sourceFps": media.input().metadata.source_fps,
            "fpsUpperBound": media.input().metadata.fps_upper_bound,
            "targetWidth": media.target().width, "targetHeight": media.target().height,
        }));
        let mut wallpaper_status = serde_json::json!({
            "enabled": self.config.wallpaper.enabled || self.wallpaper_forced,
            "visible": desktop.visible || desktop.handoff.as_ref().and_then(|handoff| handoff.window.as_ref()).is_some_and(|window| window.is_visible()),
            "pageReady": desktop.page_ready,
            "firstFrameReady": desktop.surface.as_ref().is_some_and(WallpaperSurface::first_frame_ready),
            "staticPoster": desktop.surface.as_ref().is_some_and(|surface| surface.static_poster),
            "appliedRevision": desktop.handoff.as_ref().and_then(|handoff| handoff.applied_revision).or_else(|| desktop.surface.as_ref().and_then(|surface| surface.session.diagnostics().applied_revision)),
            "desiredRevision": self.config.revision,
            "media": media_status,
            "mediaPositionMs": desktop.surface.as_ref().and_then(|surface| surface.session.media_position_ms()),
            "mediaAllocation": desktop.surface.as_ref().and_then(|surface| surface.session.media_allocation()),
            "budget": crate::wallpaper::budget::global().usage(),
            "resumePositionMs": desktop.playback.as_ref().and_then(|resume| resume.position_at(desktop.desired_revision)),
            "mediaPauseConfirmed": desktop.surface.as_ref().and_then(|surface| surface.session.media_pause_confirmed()),
            "audio": self.wallpaper_audio_status(),
            "session": desktop.surface.as_ref().map(|surface| serde_json::json!({
                "binding": surface.binding,
                "state": surface.session.state().as_str(),
                "frameKind": surface.session.diagnostics().frame_kind.map(|kind| match kind {
                    crate::wallpaper::session::FrameKind::Gl => "gl",
                    crate::wallpaper::session::FrameKind::Image => "image",
                    crate::wallpaper::session::FrameKind::Video => "video",
                }),
            })),
            "retiringControllers": self.wallpaper_retiring.len(),
            "selectionPreparing": desktop.selection.is_some(),
            "candidateLoading": desktop.candidate.is_some() || desktop.prepared.is_some(),
            "appliedSelection": desktop.handoff.as_ref().map(|handoff| &handoff.configuration.main().selection).or_else(|| desktop.surface.as_ref().map(|surface| &surface.configuration.main().selection)),
            "desiredSelection": desktop.configuration.main().selection,
            "pageTicks": desktop.heartbeat_ticks,
            "heartbeatAgeMs": desktop.heartbeat_at
                .map(|at| at.elapsed().as_millis() as u64),
            "hidden": self.wallpaper_hidden,
            "revision": self.config.revision,
            "fps": desktop.configuration.presentation().fps,
            "musicResponse": desktop.configuration.responds_to_hertz(),
            "brightness": desktop.configuration.presentation().brightness,
            "motion": desktop.configuration.presentation().motion,
            "quality": desktop.configuration.presentation().quality.as_str(),
            "batteryPolicy": "pause",
            "monitor": desktop.surface.as_ref().map(|surface| &surface.monitor.name),
            "displayId": desktop.surface.as_ref().map(|surface| surface.monitor.display_id()),
            "source": if desktop.configuration.follows_hertz() { "follow" } else { "fixed" },
            "scene": desktop.configuration.builtin().map(|state| state.scene_id),
            "settingsOpen": self.settings.is_some(),
            "previewActive": self.preview_active(),
            "mediaPreview": self.preview_diagnostics(),
            "mediaPreviewAvailable": true,
            "previewLease": self.preview_lease(),
            "monitorMissing": desktop.monitor_missing,
            "applyError": desktop.apply_error,
        });
        wallpaper_status["runtimeEnabled"] =
            self.wallpaper_target_running(&desktop.configuration).into();
        wallpaper_status["sessionStopped"] = self.feature_stops.wallpaper.into();
        wallpaper_status["exitPreferenceSaved"] =
            (!self.feature_stops.wallpaper_save_failed).into();
        wallpaper_status["applicationRule"] = serde_json::json!(desktop.application_gate.stable());
        wallpaper_status["staticFrameRetained"] = serde_json::json!(
            !desktop.visible
                && policy::retain_frame(&pause_inputs)
                && (desktop
                    .surface
                    .as_ref()
                    .is_some_and(WallpaperSurface::first_frame_ready)
                    || desktop
                        .handoff
                        .as_ref()
                        .is_some_and(|handoff| handoff.pause_retained && handoff.window.is_some()))
        );
        wallpaper_status["runtimeBuiltin"] = serde_json::json!(desktop
            .handoff
            .as_ref()
            .and_then(|handoff| handoff.runtime_builtin.as_ref())
            .or_else(|| desktop
                .surface
                .as_ref()
                .and_then(|surface| surface.runtime_builtin.as_ref())));
        let gl = desktop
            .surface
            .as_ref()
            .and_then(|surface| surface.session.gl());
        wallpaper_status["glAllocation"] = serde_json::json!(gl.and_then(|gl| gl.snapshot()));
        wallpaper_status["glLimits"] = serde_json::json!(gl.map(|gl| &gl.limits));
        wallpaper_status["handoff"] = desktop.handoff.as_ref().map_or(
            serde_json::Value::Null,
            wallpaper_handoff::Handoff::diagnostics,
        );
        wallpaper_status["playlist"] = self
            .mirror_status(&desktop.configuration.main().id)
            .unwrap_or_else(|| wallpaper_playlist::status(desktop));
        wallpaper_status["mirror"] = self.desktop.mirrors.get(&desktop.configuration.main().id).map_or(serde_json::Value::Null, |group| {
            serde_json::json!({"epoch":group.playback.epoch(),"sharedGroupClock":true,
                "currentIndex":group.playback.current_index(),"switching":group.playback.is_switching(),"failed":group.playback.is_failed(),
                "token":desktop.mirror_ticket.as_ref().map(|ticket| ticket.switch.token),
                "memberGeneration":desktop.mirror_ticket.as_ref().map(|ticket| ticket.generation),
                "clockToken":desktop.mirror_clock_token,
                "released":desktop.mirror_released,"presentedGeneration":desktop.mirror_presented})
        });
        wallpaper_status["decodeProbe"] = self.wallpaper_probe.diagnostics();
        wallpaper_status["retirements"] = serde_json::json!(self
            .wallpaper_retiring
            .iter()
            .take(64)
            .map(RetiringWallpaper::diagnostics)
            .collect::<Vec<_>>());
        wallpaper_status["retiringHandoffs"] = self.wallpaper_handoff_retiring.len().into();
        self.with_target_status(serde_json::json!({
            "ok": true,
            "managementProtocol": crate::component::MANAGEMENT_PROTOCOL,
            "bridgeProtocol": crate::component::DBX_BRIDGE_PROTOCOL,
            "desktopBuildId": crate::component::BUILD_ID,
            "capabilities": {
                "targetProfile": true,
                "requestId": true,
                "requiredDesktopBuildId": true,
                "expectedRevision": true,
                "commands": crate::management::V2_COMMANDS,
                "sourceFreshnessMs": crate::management::STALE_AFTER.as_millis() as u64,
                "sourceSwitch": "native-center",
            },
            "activeProfile": self.config.active_profile,
            "revision": self.config.revision,
            "locked": self.config.lyrics.locked,
            "enabled": self.config.lyrics.enabled,
            "runtimeEnabled": self.lyrics_running(),
            "sessionStopped": self.feature_stops.lyrics,
            "exitPreferenceSaved": !self.feature_stops.lyrics_save_failed,
            "userHidden": self.policy.user_hidden,
            "visible": self.visible,
            "source": self.source_state,
            "positionEditing": self.position_edit.is_some(),
            "policy": {
                "fullscreen": self.policy.fullscreen,
                "sessionUnavailable": self.policy.session_unavailable,
                "displayOff": self.policy.display_off,
                "noContent": self.policy.no_content,
                "wallpaperFullscreen": desktop.fullscreen_gate.stable(),
                "wallpaperMaximized": desktop.maximized_gate.stable(),
                "wallpaperApplicationRule": desktop.application_gate.stable(),
                "power": match self.wallpaper_power {
                    native::PowerState::Ac => "ac",
                    native::PowerState::Battery => "battery",
                    native::PowerState::Unknown => "unknown",
                },
            },
            "profile": self.config.active_profile,
            "wallpaper": wallpaper_status,
            // 小窗播放（桌面宠物）：web 设置页的开关与状态展示读这一节。
            "mini": {
                "pet": self.config.mini.pet,
                "visible": self.mini_host.phase != MiniPhase::Hidden,
                "pageReady": self.mini_page_ready,
                "dock": self.mini_host.geometry.dock.label(),
                "peek": self.mini_host.phase == MiniPhase::Peeking,
                "reopen": self.config.mini.reopen,
                "scale": self.config.mini.scale,
                "supported": !config::is_dbx(&self.profile),
            },
            "diagnostics": {
                "pauseReasons": policy::pause_reasons(&pause_inputs),
                "fps": {
                    "configured": desktop.configuration.presentation().fps,
                    "refreshHz": desktop.surface.as_ref().map(|surface| surface.monitor.refresh_hz),
                    "divisor": divisor,
                    "effectiveBudget": budget,
                    "effective": if desktop.visible { budget } else { 0.0 },
                    "measured": if desktop.visible
                        && desktop.heartbeat_at
                            .is_some_and(|at| at.elapsed() < Duration::from_secs(5))
                    {
                        desktop.measured_fps
                    } else {
                        None
                    },
                },
                "page": {
                    "ready": desktop.page_ready,
                    "ticks": desktop.heartbeat_ticks,
                    "draws": desktop.heartbeat_draws,
                    "heartbeatAgeMs": desktop.heartbeat_at
                        .map(|at| at.elapsed().as_millis() as u64),
                    "evalFailures": desktop.surface
                        .as_ref()
                        .map(|surface| surface.eval_failures())
                        .unwrap_or(0),
                    "zoom": desktop.surface.as_ref().map(|surface| surface.zoom),
                },
                "monitor": desktop.surface.as_ref().map(|surface| {
                    serde_json::json!({
                        "name": surface.monitor.name,
                        "displayId": surface.monitor.display_id(),
                        "left": surface.monitor.left,
                        "top": surface.monitor.top,
                        "width": surface.monitor.width,
                        "height": surface.monitor.height,
                        "dpi": surface.monitor.dpi,
                        "refreshHz": surface.monitor.refresh_hz,
                    })
                }),
                "recovery": {
                    "attempts": desktop.recovery_attempts.len(),
                    "terminal": desktop.recovery_terminal,
                },
                "feed": {
                    "hasSnapshot": self.wallpaper_last.is_some(),
                    "lastSeq": self.wallpaper_last.as_ref().map(|snapshot| snapshot.seq),
                },
            },
        }), self.config.active_profile.as_ref())
    }

    fn handle_native(&mut self, event: NativeEvent, target: &EventLoopWindowTarget<()>) {
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
                if self
                    .desktop
                    .recovery
                    .charge(
                        crate::wallpaper::session::FaultDomain::Global,
                        Instant::now(),
                    )
                    .is_ok()
                {
                    self.for_each_desktop(|app| {
                        app.cancel_wallpaper_transition();
                        app.close_wallpaper_handoff();
                        app.retire_wallpaper_surface();
                        app.desktop.page_ready = false;
                        app.desktop.visible = false;
                        if app.wallpaper_target_running(&app.desktop.configuration) {
                            if let Err(error) = app.ensure_wallpaper_surface_target(target) {
                                app.desktop.apply_error = Some(error.to_string());
                            }
                        }
                    });
                } else {
                    self.recompute_wallpaper();
                    self.send_settings_status(
                        Some("桌面宿主连续重启，已停止自动重挂；请从托盘重新挂载"),
                        None,
                    );
                }
                // explorer 重建常伴随显示器拓扑变化：贴边的小窗要重新落位。
                let action = self.mini_host.handle(MiniEvent::DisplayChanged);
                self.apply_mini_action(action, target);
            }
            NativeEvent::SessionUnavailable(unavailable) => {
                if self.policy.session_unavailable != unavailable {
                    log(&format!("session_unavailable={unavailable}"));
                    self.policy.session_unavailable = unavailable;
                    // 接电/解锁/唤醒事件后的重采样（设计 §13.2）。
                    self.wallpaper_power = native::power_state();
                    self.recompute_visibility();
                    self.recompute_wallpaper();
                }
            }
            NativeEvent::DisplayOff(off) => {
                if self.policy.display_off != off {
                    log(&format!("display_off={off}"));
                    self.policy.display_off = off;
                    self.wallpaper_power = native::power_state();
                    self.recompute_visibility();
                    self.recompute_wallpaper();
                }
            }
            NativeEvent::HotkeyFired(id) => {
                // 复用托盘同款恢复命令：只表达解锁并定位的意图，不绕过会话/全屏策略。
                if self
                    .hotkey
                    .as_ref()
                    .is_some_and(|manager| manager.handles(id))
                {
                    log("recovery hotkey fired; unlock and locate lyrics");
                    self.locate();
                }
            }
        }
    }

    fn source_expiry_deadline(&self) -> Option<Instant> {
        let lyrics = self
            .last_snapshot
            .as_ref()
            .map(|_| self.last_update + STALE_AFTER);
        let wallpaper = config::is_dbx(&self.profile)
            .then_some(self.wallpaper_last_update)
            .flatten()
            .filter(|_| self.wallpaper_last.is_some())
            .map(|at| at + STALE_AFTER);
        lyrics.into_iter().chain(wallpaper).min()
    }

    fn expire_source_data(&mut self, now: Instant) {
        if config::is_dbx(&self.profile)
            && self
                .wallpaper_last_update
                .is_some_and(|at| now.saturating_duration_since(at) >= STALE_AFTER)
            && self.wallpaper_last.is_some()
        {
            self.handle_wallpaper_feed(Err(FeedError {
                code: "dbx_stale",
                message: "等待所选 DBX 的新快照".into(),
            }));
        }
        if now.saturating_duration_since(self.last_update) >= STALE_AFTER
            && self.last_snapshot.is_some()
        {
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

    fn tick(&mut self, target: &EventLoopWindowTarget<()>) {
        if self.calibration_pending.as_ref().is_some_and(|p| {
            !self.lyrics_running()
                || self.last_update.elapsed() >= STALE_AFTER
                || self.last_snapshot.as_ref().is_none_or(|s| !p.matches(s))
        }) {
            self.cancel_calibration();
        }
        self.expire_inline_position_edit();
        self.reap_handoff_workspaces();
        self.poll_wallpaper_retirements();
        self.tick_wallpaper_apply(target);
        self.tick_preview(target);
        self.tick_mirror_playback();
        self.for_each_desktop(|app| {
            app.poll_wallpaper_handoff();
            app.tick_wallpaper_follow(target);
            app.tick_media_wallpaper(target);
            app.tick_wallpaper_playlist();
        });
        self.sync_dbx_feed();
        self.expire_source_data(Instant::now());
        self.flush_save();
        self.maybe_finish_feature_exit();
        // 小窗贴边隐藏的低频推进（穿透窗收不到鼠标事件，靠轮询光标）。
        if matches!(self.mini_host.phase, MiniPhase::Docked | MiniPhase::Peeking) {
            let cursor_inside = self.mini_hwnd().is_some_and(mini_native::cursor_in_window);
            let action = self
                .mini_host
                .tick_peek(self.config.mini.edge_hide, cursor_inside);
            if !matches!(action, MiniAction::None) {
                self.apply_mini_action(action, target);
                self.mini_send_config();
            }
        }
        // 桌宠素材热重载：目录浅层 stat 一遍（几个文件），签名变了就通知页面
        // 重新拉皮肤。用户落素材是多文件操作，partial 状态等下一次变化自然收敛。
        if self.mini.is_some() {
            let signature = self.pet_skin_signature();
            if signature != self.mini_skin_signature {
                self.mini_skin_signature = signature;
                log("pet skin changed; reloading");
                self.mini_eval(
                        "window.hertzMini && window.hertzMini.reloadSkin && window.hertzMini.reloadSkin();",
                    );
            }
        }
        if self
            .mini_restore_pending
            .as_ref()
            .is_some_and(|request| request.started.elapsed() > Duration::from_secs(12))
        {
            self.cancel_mini_restore();
            self.mini_eval("window.hertzMini && window.hertzMini.flash('主窗口尚未返回，请重试');");
            self.mini_sync_runtime();
        }
        let now = Instant::now();
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| now >= preview.lease_until)
        {
            self.close_preview();
        }
        // 250 ms 巡检：预览策略、逐屏全屏去抖、拓扑宽限与几何校准。
        self.poll_wallpaper_policy(target);
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
            self.for_each_desktop(|app| {
                if app.wallpaper_target_running(&app.desktop.configuration)
                    && app
                        .desktop
                        .surface
                        .as_ref()
                        .is_none_or(|surface| !native::wallpaper_alive(surface.hwnd()))
                {
                    log("wallpaper surface unavailable; recovering");
                    app.recover_wallpaper(target);
                }
                if let Some(surface) = app.desktop.surface.as_ref() {
                    let startup_stalled = (!app.desktop.page_ready
                        && surface.created_at.elapsed() > HEARTBEAT_STALE)
                        || surface
                            .frame_wait_since
                            .is_some_and(|at| at.elapsed() > HEARTBEAT_STALE);
                    let stalled = app.desktop.visible
                        && app.desktop.page_ready
                        && app
                            .desktop
                            .heartbeat_at
                            .is_some_and(|at| at.elapsed() > HEARTBEAT_STALE);
                    let eval_failed = app
                        .desktop
                        .surface
                        .as_ref()
                        .is_some_and(|surface| surface.eval_failures() >= 3);
                    if stalled || eval_failed || startup_stalled {
                        let superseded = app.is_mirror_target()
                            && app.desktop.surface.as_ref().is_some_and(|surface| {
                                !app.mirror_surface_matches(surface) && !surface.static_poster
                            });
                        if !superseded
                            && matches!(
                                app.desktop.configuration.main().selection,
                                crate::wallpaper::config::Selection::Playlist { .. }
                            )
                        {
                            app.desktop.failed_revision = Some(app.desktop.desired_revision);
                            app.desktop.apply_error =
                                Some("当前轮播画面停止响应，请显式重试".into());
                        }
                        log(if startup_stalled {
                            "wallpaper session handshake/first frame timed out; recovering"
                        } else if stalled {
                            "wallpaper page heartbeat stalled; recovering"
                        } else {
                            "wallpaper WebView eval failed repeatedly; recovering"
                        });
                        app.reset_wallpaper_page_stats();
                        app.retire_wallpaper_surface();
                        app.desktop.page_ready = false;
                        app.desktop.visible = false;
                        app.wallpaper_generation = app.wallpaper_generation.wrapping_add(1);
                        app.recover_wallpaper(target);
                    }
                }
            });
            self.ensure_on_screen();
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
            let power = native::power_state();
            if power != self.wallpaper_power {
                self.wallpaper_power = power;
                self.recompute_wallpaper();
            }
        }
    }

    fn ensure_on_screen(&mut self) {
        if let Some(area) = self.target_area() {
            if self
                .lyrics_placed_area
                .as_ref()
                .is_none_or(|previous| lyrics_work_area_changed(previous, &area))
            {
                // A taskbar/work-area or DPI change can invalidate capacity while
                // the old window center remains on-screen. Reuse the saved anchor.
                self.place(true);
                self.send_config();
                return;
            }
        }
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
        let area = self.target_area();
        let width = area
            .as_ref()
            .map(|area| self.lyrics_widths_dip(area).1)
            .unwrap_or(self.config.lyrics.width);
        if self.vocal_document_mode() && self.config.lyrics.show_vocals {
            let available = area
                .as_ref()
                .map(|area| f64::from(area.height()) / area.scale())
                .unwrap_or(1080.0)
                - self.panel_height;
            return vocal_geometry(
                self.config.lyrics.font_size,
                self.measured_vocal_slot(),
                available,
            )
            .height;
        }
        self.ordinary_lyrics_height(width)
    }

    fn vocal_document_mode(&self) -> bool {
        self.current_document
            .as_ref()
            .is_some_and(|document| document.vocal_schema_version == Some(1))
    }

    fn lyrics_font_key(&self) -> String {
        let c = &self.config.lyrics;
        format!(
            "{}|{}|{}|{}",
            c.font_family, c.font_size, c.font_weight, c.outline_width
        )
    }

    fn measured_vocal_slot(&self) -> f64 {
        if self.lyrics_measure_font.as_deref() == Some(self.lyrics_font_key().as_str()) {
            self.lyrics_measured_slot
        } else {
            0.0
        }
    }

    fn ordinary_lyrics_height(&self, width: f64) -> f64 {
        if self.vocal_document_mode() {
            let mut single = self.config.lyrics.clone();
            single.layout = Layout::Single;
            lyrics_base_height_dip(&single, width)
        } else {
            lyrics_base_height_dip(&self.config.lyrics, width)
        }
    }

    fn lyrics_vocal_geometry(&self) -> VocalGeometry {
        let available = self
            .target_area()
            .map(|area| f64::from(area.height()) / area.scale())
            .unwrap_or(1080.0)
            - self.panel_height;
        vocal_geometry(
            self.config.lyrics.font_size,
            self.measured_vocal_slot(),
            available,
        )
    }

    fn lyrics_geometry_value(&self) -> serde_json::Value {
        let geometry = self.lyrics_vocal_geometry();
        serde_json::json!({
            "documentKey": self.current_document_key,
            "fontKey": self.lyrics_font_key(),
            "showVocals": self.config.lyrics.show_vocals,
            "bilingual": self.config.lyrics.bilingual,
            "capacity": if self.config.lyrics.show_vocals { geometry.capacity } else if self.config.lyrics.bilingual { 2 } else { 1 },
            "slotHeight": geometry.slot_height,
        })
    }

    fn send_lyrics_geometry(&self) {
        if !self.page_ready {
            return;
        }
        let payload = self.lyrics_geometry_value().to_string();
        if self.lyrics_geometry_payload.borrow().as_deref() == Some(payload.as_str()) {
            return;
        }
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applyGeometry({payload});"
        ));
        *self.lyrics_geometry_payload.borrow_mut() = Some(payload);
    }

    /// `(名义最大宽度, 贴合后的实际宽度)`，均为 DIP。锚点始终按名义宽度换算，
    /// 贴合只是让窗口朝歌词那一侧收进去，所以换句时字不会漂。
    fn lyrics_widths_dip(&self, area: &native::WorkArea) -> (f64, f64) {
        let max_width = (f64::from(area.width()) / area.scale() * 0.9).max(240.0);
        let reference = self.config.lyrics.width.min(max_width);
        (
            reference,
            lyrics_width_dip(self.lyrics_fit_width, reference, max_width),
        )
    }

    /// 页面按当前歌词内容要的最小窗口宽度；拖动期间先记下，松手后由 place 统一生效。
    fn set_fitted_width(&mut self, required: f64) {
        if !required.is_finite() || self.position_edit.is_some() {
            return;
        }
        let required = required.clamp(160.0, 2400.0);
        if (required - self.lyrics_fit_width).abs() < 0.5 {
            return;
        }
        self.lyrics_fit_width = required;
        self.place(true);
    }

    /// 顶部不动的窗口高度调整：样式条只往下长，歌词不跳。
    fn set_panel_height(&mut self, height: f64) {
        let height = height.clamp(0.0, 512.0);
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
        let (reference_dip, width_dip) = self.lyrics_widths_dip(&area);
        let height_dip =
            (self.base_height_dip() + self.panel_height).min(f64::from(area.height()) / scale);
        let width = (width_dip * scale).round() as i32;
        let height = (height_dip * scale).round() as i32;
        let reference_width = (reference_dip * scale).round() as i32;
        let offset = lyrics_fit_offset(reference_width, width, self.config.lyrics.align);
        let (anchor_x, anchor_y) = if keep_anchor {
            (self.config.lyrics.anchor_x, self.config.lyrics.anchor_y)
        } else {
            (0.5, 0.84)
        };
        let available_y = (area.height() - height).max(0);
        let mut x = lyrics_left_x(&area, reference_width, anchor_x, offset);
        let mut y = area.top + (f64::from(available_y) * anchor_y).round() as i32;
        if let Some(top) = self.panel_top {
            y = top.clamp(area.top, (area.top + available_y).max(area.top));
        }
        if self.position_edit.is_some() || self.vocal_document_mode() {
            (x, y) = bounded_lyrics_position(x, y, width, height, &area);
        }
        if self.position_edit.is_some() {
            self.config.lyrics.anchor_x = lyrics_anchor_from_x(&area, reference_width, x, offset);
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
        self.lyrics_placed_area = Some(area.clone());
        self.send_lyrics_geometry();
        self.policy.no_content =
            self.last_snapshot.as_ref().is_none_or(|snapshot| {
                snapshot.track.is_none() || snapshot.lyrics.status != "ready"
            }) || self.current_document.is_none()
                || (self.vocal_document_mode()
                    && self.config.lyrics.show_vocals
                    && self.lyrics_vocal_geometry().capacity == 0);
        self.recompute_visibility();
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
        // A move caused by an outage hiding the window must not rewrite the saved anchor or pin the monitor.
        if self.policy.no_content {
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
        // 贴合宽度不改变锚点语义：先减掉窗口朝歌词那侧收进去的量，再按名义宽度归一化。
        let reference_width = (self.lyrics_widths_dip(&area).0 * area.scale()).round() as i32;
        let offset = lyrics_fit_offset(reference_width, width, self.config.lyrics.align);
        if area.width() <= reference_width || area.height() <= anchor_height {
            return;
        }
        self.config.lyrics.anchor_x =
            lyrics_anchor_from_x(&area, reference_width, rect.left, offset);
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
        if !self.host_tray {
            return;
        }
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
        let toggle = CheckMenuItem::new(
            "显示歌词",
            self.lyrics_running(),
            self.lyrics_running() && !self.policy.user_hidden,
            None,
        );
        let locate = MenuItem::new("解锁并定位", true, None);
        let autostart = CheckMenuItem::new("开机启动", true, self.config.launch_at_login, None);
        let wallpaper_enabled = self.wallpaper_running();
        let wallpaper_toggle = self
            .desktop
            .runtimes
            .values()
            .any(|desktop| desktop.surface.is_some())
            .then(|| CheckMenuItem::new("显示壁纸", true, !self.wallpaper_hidden, None));
        let wallpaper_retry = wallpaper_enabled.then(|| MenuItem::new("重新挂载壁纸", true, None));
        let mini_toggle = CheckMenuItem::new(
            "小窗播放（桌面宠物）",
            !config::is_dbx(&self.profile),
            self.mini_host.phase != MiniPhase::Hidden,
            None,
        );
        let mini_assets = MenuItem::new("打开桌宠素材文件夹", true, None);
        let settings = MenuItem::new("桌面歌词与壁纸", true, None);
        let lyrics_exit = MenuItem::new("退出桌面歌词", self.lyrics_running(), None);
        let wallpaper_exit = MenuItem::new("退出桌面壁纸", self.wallpaper_running(), None);
        let quit = MenuItem::new("退出桌面组件", true, None);
        let separator_after_toggle = PredefinedMenuItem::separator();
        let separator_before_settings = PredefinedMenuItem::separator();
        let separator_before_wallpaper = PredefinedMenuItem::separator();
        let separator_before_quit = PredefinedMenuItem::separator();
        menu.append_items(&[&toggle, &separator_after_toggle, &locate, &autostart])?;
        menu.append(&separator_before_settings)?;
        menu.append(&settings)?;
        menu.append(&mini_toggle)?;
        menu.append(&mini_assets)?;
        if let Some(wallpaper) = wallpaper_toggle.as_ref() {
            menu.append(&separator_before_wallpaper)?;
            menu.append(wallpaper)?;
        }
        if let Some(retry) = wallpaper_retry.as_ref() {
            menu.append(retry)?;
        }
        menu.append(&separator_before_quit)?;
        menu.append(&lyrics_exit)?;
        menu.append(&wallpaper_exit)?;
        menu.append(&quit)?;
        let actions = TrayActions {
            toggle_id: toggle.id().0.clone(),
            autostart_id: autostart.id().0.clone(),
            settings_id: settings.id().0.clone(),
            wallpaper_toggle_id: wallpaper_toggle.as_ref().map(|item| item.id().0.clone()),
            wallpaper_retry_id: wallpaper_retry.as_ref().map(|item| item.id().0.clone()),
            mini_toggle_id: mini_toggle.id().0.clone(),
            mini_assets_id: mini_assets.id().0.clone(),
            locate_id: locate.id().0.clone(),
            lyrics_exit_id: lyrics_exit.id().0.clone(),
            wallpaper_exit_id: wallpaper_exit.id().0.clone(),
            quit_id: quit.id().0.clone(),
            toggle,
            autostart,
            wallpaper_toggle,
            mini_toggle,
            lyrics_exit,
            wallpaper_exit,
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
    run_with(RunConfig {
        args: Args::parse()?,
        embedded: false,
        host_tray: true,
        commands: None,
        ready: None,
        settings_events: None,
    })
}

/// 独立 exe 与播放器进程内宿主共用的唯一启动路径。
pub(crate) fn run_with(run_config: RunConfig) -> Result<()> {
    let RunConfig {
        mut args,
        embedded,
        host_tray,
        commands,
        ready,
        settings_events,
    } = run_config;
    let mut ready = ReadyGuard::new(ready);
    let locate_on_start = args.locate;
    init_log();
    let _ = crate::wallpaper::budget::global();
    let _root_owner = crate::wallpaper_upgrade::prepare(&config::base_dir())?;
    if args.wallpaper_feed_test {
        let config = config::load()?;
        let profile = args
            .data_dir
            .take()
            .map(|data_dir| config::standalone(data_dir, "custom"))
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
    // 内嵌形态由播放器自己的单实例握手保证唯一；再抢全局互斥体会让
    // 遗留的开机自启组件把播放器的歌词窗口顶掉。
    if !embedded {
        let Some(_instance) = native::acquire_single_instance() else {
            log("another hertz-desktop instance is running; exiting");
            return Ok(());
        };
    }
    let (mut config, migration_notice) = config::load_with_notice()?;
    config.sanitize();
    let profile = args
        .data_dir
        .take()
        .map(|data_dir| config::standalone(data_dir, "custom"))
        .or_else(|| config.active_profile.clone())
        .or_else(config::detect_profile)
        .unwrap_or_else(default_profile);
    let explicit_binding = args.data_dir.is_some();
    // The CLI value was consumed above; custom means it was explicitly supplied.
    let explicit_binding = explicit_binding
        || matches!(&profile, Profile::Standalone { edition, .. } if edition == "custom");
    if config.unbound_domain.is_none() || explicit_binding || config.active_profile.is_some() {
        let mut next = config.clone();
        if next.activate_profile(profile.clone())? {
            config::commit(&mut config, next)?;
        }
    }
    let wallpaper_forced = args.wallpaper;
    log(&format!(
        "profile={} edition={} discovery={}",
        std::path::Path::new(profile.data_dir()).display(),
        profile.edition(),
        std::path::Path::new(profile.data_dir())
            .join("vmusicd.json")
            .display()
    ));

    std::fs::create_dir_all(config::webview_dir()).ok();

    // Win32 类回调在进程内共享；与播放器保持同一个 Tao 类型，业务事件另走类型化队列。
    let mut loop_builder = EventLoopBuilder::<()>::new();
    // 播放器内嵌形态的事件循环跑在自己那条线程上（主窗口的事件循环归播放器）。
    // tao 默认禁止 off-main event loop，Windows 上用官方开关显式放行。
    if embedded {
        loop_builder.with_any_thread(true);
    }
    log("desktop startup: creating event loop");
    let mut event_loop = loop_builder.build();
    log("desktop startup: event loop ready");
    let (proxy, events) = native_events::channel(event_loop.create_proxy());
    // 托盘/菜单事件处理器是进程全局的：播放器已有托盘时绝不抢占，
    // 否则同一个进程里两个托盘会互相吞掉对方的菜单点击。
    if host_tray {
        install_global_handlers(proxy.clone());
    }

    let icon = window_icon()?;
    let window = WindowBuilder::new()
        .with_title("Hertz 桌面歌词")
        .with_window_icon(Some(icon.clone()))
        .with_taskbar_icon(Some(icon))
        .with_inner_size(tao::dpi::LogicalSize::new(
            config.lyrics.width.max(240.0),
            lyrics_base_height_dip(&config.lyrics, config.lyrics.width.max(240.0)),
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
    log("desktop startup: lyric window ready");
    let hwnd = window.hwnd() as HWND;
    native::strip_title_bar(hwnd);
    native::make_tool_window(hwnd);
    native::install_hit_test_subclass(hwnd);

    let page_proxy = proxy.clone();
    // Desktop profiles are explicit per surface. A process-wide WebView2
    // override would redirect the embedded player's main and OBS contexts.
    let mut web_context = WebContext::new(Some(config::webview_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
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
    log("desktop startup: lyric WebView ready");

    let mini_host = MiniHost::new(profile.clone());
    let audio_proxy = proxy.clone();
    let wallpaper_audio =
        crate::wallpaper::audio_service::AudioService::start(Arc::new(move || {
            let _ = audio_proxy.send_event(UserEvent::WallpaperAudio);
        }))
        .map_err(anyhow::Error::msg)?;
    log("desktop startup: audio service ready");
    let mut app = App {
        desktop: wallpaper_runtime::DesktopTargets::default(),
        wallpaper_apply: None,
        playlist_writes: 0,
        window,
        webview,
        _web_context: web_context,
        tray: None,
        tray_actions: None,
        embedded,
        host_tray,
        committed_config: config.clone(),
        hotkey: {
            // 快捷键宿主窗口属于主事件循环线程；注册失败保留偏好，
            // 托盘与设置页仍可更换/清空（§5.1）。
            let mut manager = crate::hotkey::Manager::new(native::install_hotkey_window()?);
            if let Some(saved) = config.recovery_hotkey.as_ref() {
                if let Err(error) = manager.initialize(Some(saved)) {
                    log(&format!("hotkey startup register failed: {error}"));
                }
            }
            Some(manager)
        },
        config,
        dbx: None,
        dbx_session: None,
        source_health: crate::management::SourceHealth::default(),
        wallpaper_last_update: None,
        wallpaper_audio,
        wallpaper_audio_dispatch: Default::default(),
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
        calibration_pending: None,
        last_update: Instant::now(),
        current_track: None,
        current_document_key: None,
        current_document: None,
        page_ready: false,
        page_clock: None,
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
        wallpaper_retiring: Vec::new(),
        wallpaper_handoff_retiring: Vec::new(),
        wallpaper_probe: crate::wallpaper::decode_probe::ProbeHost::default(),
        wallpaper_last: None,
        wallpaper_feed_logged: false,
        wallpaper_hidden: false,
        wallpaper_forced,
        feature_stops: feature_exit::FeatureStops::default(),
        last_topology_check: Instant::now(),
        wallpaper_power: native::power_state(),
        source_generation: 1,
        lyrics_feed_stop: Arc::new(AtomicBool::new(true)),
        wallpaper_feed_stop: None,
        wallpaper_generation: 1,
        library_delete: None,
        wallpaper_library: crate::wallpaper::service::LibraryService::start(
            config::base_dir(),
            crate::wallpaper::decode_probe::ProbeClient::native(proxy.clone()),
        ),
        settings_drafts: Default::default(),
        wallpaper_ai: crate::wallpaper::ai::NativeAi::new(),
        settings_generation: 0,
        settings: None,
        settings_events,
        settings_candidate: None,
        settings_tab: "wallpaper".into(),
        settings_navigation: 0,
        preview: None,
        work_preview_epoch: 0,
        migration_notice,
        position_edit: None,
        placed_position: None,
        panel_height: 0.0,
        panel_top: None,
        lyrics_fit_width: 0.0,
        lyrics_measured_slot: 0.0,
        lyrics_measure_font: None,
        lyrics_geometry_payload: RefCell::new(None),
        lyrics_placed_area: None,
        mini: None,
        mini_page_ready: false,
        mini_host,
        mini_last_snapshot: None,
        mini_feed_logged: false,
        mini_drag_offset: None,
        mini_cover_version: 0,
        mini_cover: Arc::new(std::sync::Mutex::new(None)),
        mini_skin_signature: None,
        mini_runtime: MiniRuntime::default(),
        mini_context_menu: None,
        mini_restore_pending: None,
        proxy: proxy.clone(),
    };
    app.policy.locked = app.config.lyrics.locked;
    // 配置 → 状态机的初值。宠物尺寸等运行时量由页面稍后上报。
    {
        let mini = &app.config.mini;
        let host = &mut app.mini_host;
        host.pet = mini.pet;
        host.locked = mini.locked;
        host.always_on_top = mini.always_on_top;
        host.auto_on_main_hidden = mini.auto_on_main_hidden;
        host.geometry = mini.geometry.clone();
        host.scale = mini.scale;
    }
    if host_tray {
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
    }
    native::set_locked(app.hwnd(), app.config.lyrics.locked);
    app.place(true);
    app.recompute_visibility();
    app.reconcile_desktops(&native::wallpaper_monitors(), Instant::now())?;
    app.recompute_wallpaper();
    if app.config.wallpaper.enabled || app.wallpaper_forced {
        if let Err(error) = app.ensure_wallpaper_surface(&event_loop) {
            log(&format!("wallpaper startup failed: {error}"));
        }
    }
    if locate_on_start {
        app.locate();
    }
    if args.settings {
        if let Some(tab) = args.settings_tab.as_deref() {
            app.settings_tab = tab.to_string();
        }
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
    if !config::is_dbx(&app.profile) && app.config.active_profile.is_some() {
        app.sync_lyrics_feed();
        // 小窗来源线程：常驻轮询，事件侧按相位/播放态调节奏。
        spawn_mini_feed(
            app.profile.clone(),
            proxy.clone(),
            app.source_generation,
            app.mini_runtime.clone(),
        );
        // 上次退出时小窗还开着 → 这次启动直接恢复。
        if app.config.mini.reopen {
            let action = app
                .mini_host
                .handle(MiniEvent::Enter(crate::mini::EnterReason::Restored));
            app.apply_mini_action(action, &event_loop);
        }
    } else if config::is_dbx(&app.profile) {
        app.sync_dbx_feed();
    }
    spawn_ticker(proxy.clone());
    if !embedded {
        // 管理命名管道只属于独立 exe；播放器内嵌形态的命令走下面的进程内通道。
        let pipe_proxy = proxy.clone();
        if let Err(error) = crate::pipe::start(move |request| {
            let _ = pipe_proxy.send_event(UserEvent::Pipe(request));
        }) {
            log(&format!("control pipe unavailable: {error:#}"));
        }
    }
    if let Some(commands) = commands {
        let host_proxy = proxy.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("hertz-desktop-host-commands".into())
            .spawn(move || {
                for request in commands {
                    if host_proxy.send_event(UserEvent::Host(request)).is_err() {
                        break;
                    }
                }
            })
        {
            log(&format!("host command channel unavailable: {error:#}"));
        }
    }
    let message_proxy = proxy.clone();
    if let Err(error) = native::install_message_window(move |event| {
        let _ = message_proxy.send_event(UserEvent::Native(event));
    }) {
        log(&format!("message window unavailable: {error:#}"));
    }

    // 窗口、页面、事件循环都已就位；此后 send_event 一定会被消费。
    log("desktop startup: host ready");
    ready.ok();

    // tao 的 `run()` 在 Windows 上收尾会 `std::process::exit`：内嵌形态若也走
    // 它，「退出桌面歌词」会把整个播放器一起带走。宿主改用可返回的
    // `run_return`；独立 exe 保持原来的 `run()`（避免 run_return 在窗口缩放
    // 期间已知的卡顿）。两条路共用下面这份事件处理闭包，行为逐字一致。
    macro_rules! event_loop_handler {
        () => {
            move |event, target, control_flow| {
        let Some(event) = events.map_event(event) else { return; };
        // Freshness is a deadline, independent of the 500 ms maintenance ticker.
        // This also clears expired data before handling a queued status/document.
        if !matches!(&event, Event::LoopDestroyed) {
            app.wallpaper_probe.tick();
            app.expire_source_data(Instant::now());
        }
        *control_flow = app
            .source_expiry_deadline()
            .map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        match event {
            Event::UserEvent(UserEvent::WallpaperAudio) => { app.wallpaper_audio.take_latest(); }
            Event::UserEvent(UserEvent::WallpaperAudioDelivered(slot, token)) => { app.wallpaper_audio_dispatch.acknowledge(slot, token); }
            Event::UserEvent(UserEvent::WallpaperMirrorClock(generation, sent, received, page_ms)) => {
                app.accept_mirror_clock(generation, sent, received, page_ms);
            }
            Event::UserEvent(UserEvent::Dbx(generation, message)) => {
                if generation == app.source_generation && config::is_dbx(&app.profile) { app.handle_dbx(*message); }
            }
            Event::UserEvent(UserEvent::Feed(generation, stop, started, result)) => {
                if generation == app.source_generation && !stop.load(Ordering::Acquire) && app.lyrics_needed() {
                    match *result {
                        Ok(update) => app.handle_update(update, started),
                        Err(message) => app.handle_feed_error(message),
                    }
                } else {
                    log(&format!(
                        "ignore stale lyrics feed generation={generation} current={}",
                        app.source_generation
                    ));
                }
            }
            Event::UserEvent(UserEvent::WallpaperFeed(generation, stop, started, mut result)) => {
                if generation == app.source_generation && !stop.load(Ordering::Acquire) && !app.feature_stops.wallpaper {
                    if let Ok(snapshot) = result.as_mut() {
                        if started.elapsed() >= STALE_AFTER { return; }
                        snapshot.received_at = Some(started);
                    }
                    if let Ok(snapshot) = result.as_ref() {
                        app.source_health.accept(false, started, &snapshot.server.session);
                    }
                    app.handle_wallpaper_feed(*result);
                } else {
                    log(&format!(
                        "ignore stale wallpaper feed generation={generation} current={}",
                        app.source_generation
                    ));
                }
            }
            Event::UserEvent(UserEvent::MediaPreviewSelection(id, result)) => {
                app.finish_preview_selection(id, result.map(|media| *media), target);
            }
            Event::UserEvent(UserEvent::WallpaperSelection(id, result)) => {
                app.finish_wallpaper_selection(id, result.map(|media| *media), target);
            }
            Event::UserEvent(UserEvent::WallpaperApplyLayouts(id, result)) => {
                app.finish_apply_layouts(id, result, target);
            }
            Event::UserEvent(UserEvent::WallpaperPage(generation, body)) => {
                app.handle_wallpaper_page(generation, &body)
            }
            Event::UserEvent(UserEvent::WallpaperMedia(id, response)) => {
                crate::wallpaper::webresource::complete(id, *response);
            }
            Event::UserEvent(UserEvent::WallpaperProbe(request)) => {
                app.wallpaper_probe.start(*request, target, proxy.clone());
            }
            Event::UserEvent(UserEvent::WallpaperProbePage(id, body)) => {
                app.wallpaper_probe.page(id, &body);
            }
            Event::UserEvent(UserEvent::WallpaperProbeEnvironment(reply)) => {
                let browser = app.settings.as_ref()
                    .map(|surface| crate::wallpaper::probe_environment::browser_version(&surface.webview))
                    .or_else(|| app.desktop.runtimes.values().find_map(|desktop| desktop.surface.as_ref())
                        .map(|surface| crate::wallpaper::probe_environment::browser_version(&surface.webview)))
                    .flatten()
                    .or_else(|| crate::wallpaper::probe_environment::browser_version(&app.webview));
                let _ = reply.send(browser);
            }
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            Event::UserEvent(UserEvent::WallpaperProbeTestResult(nonce, value)) => {
                for surface in app.desktop.runtimes.values().filter_map(|desktop| desktop.surface.as_ref()) {
                    surface.eval(&format!("window.__nativeImportProbes ||= {{}}; window.__nativeImportProbes[{nonce}]={value};"));
                }
            }
            Event::UserEvent(UserEvent::SettingsPage(generation, body)) => {
                if generation == app.settings_generation && app.settings.is_some() { app.handle_settings_page(&body, target); }
            }
            Event::UserEvent(UserEvent::WallpaperAiResult(owner, request, result)) => {
                app.finish_ai_catalog(owner, request, *result);
            }
            Event::UserEvent(UserEvent::WallpaperManagement(reply, value)) => { app.send_wallpaper_management(reply, value); }
            Event::UserEvent(UserEvent::WorkPreviewReady(request, owner, epoch, reply, document)) => {
                app.finish_work_preview(request, owner, epoch, reply, *document, target);
            }
            Event::UserEvent(UserEvent::PlaylistWriteFinished(id)) => {
                app.playlist_writes -= 1;
                if let Some(id) = id { app.playlist_changed(&id); }
            }
            Event::UserEvent(UserEvent::LibraryDeleteFinished(id)) => {
                if app.library_delete.as_deref() == Some(id.as_str()) { app.library_delete = None; }
            }
            Event::UserEvent(UserEvent::MiniFeed(generation, started, result)) => {
                if generation == app.source_generation {
                    app.handle_mini_feed(started, *result, target);
                }
            }
            Event::UserEvent(UserEvent::MiniPosition(generation, ms)) => {
                if generation == app.source_generation { app.mini_send_position(ms); }
            }
            Event::UserEvent(UserEvent::MiniDrag(generation, event)) => {
                if generation != app.source_generation { return; }
                match event {
                DragEvent::Move(x, y) => app.mini_drag_move(x, y),
                DragEvent::End => {
                    let action = app.mini_host.handle(MiniEvent::DragEnd);
                    app.apply_mini_action(action, target);
                    app.mini_save_geometry();
                    app.mini_send_config();
                }
                }
            },
            Event::UserEvent(UserEvent::MiniPage(body)) => app.mini_page_command(&body, target),
            Event::UserEvent(UserEvent::MiniControl(generation, result)) => {
                if generation != app.source_generation { return; }
                if let Err(message) = result.as_ref() {
                    log(&format!("mini control failed: {message}"));
                    app.mini_eval("window.hertzMini && window.hertzMini.flash('操作未完成，请重试');");
                }
            }
            Event::UserEvent(UserEvent::MiniRestore(generation, cancelled, result)) => {
                if generation != app.source_generation { return; }
                if !app.mini_restore_pending.as_ref().is_some_and(|request| Arc::ptr_eq(&request.cancelled, &cancelled)) { return; }
                if let Err(message) = result {
                    log(&format!("mini restore failed: {message}"));
                    app.cancel_mini_restore();
                    app.mini_eval("window.hertzMini && window.hertzMini.flash('主窗口未能恢复，请重试');");
                    app.mini_sync_runtime();
                } else if let Some(request) = app.mini_restore_pending.as_mut() {
                    request.ready = true;
                }
            }
            Event::UserEvent(UserEvent::Tick) => app.tick(target),
            Event::UserEvent(UserEvent::Page(body)) => app.page_command(&body),
            Event::UserEvent(UserEvent::LyricControl(generation, result)) => {
                if generation == app.source_generation {
                    let error = result.err();
                    if let Some(message) = error.as_ref() { log(&format!("lyric control failed: {message}")); }
                    let message = if error.is_some() { "操作未完成，请重试或返回播放器" } else { "" };
                    app.eval(&format!("window.hertzLyrics.controlDone({});", serde_json::to_string(message).unwrap()));
                }
            }
            Event::UserEvent(UserEvent::LyricCalibration(generation, id, result)) => {
                if generation == app.source_generation && app.calibration_pending.as_ref().is_some_and(|p|p.id==id && !p.cancel.load(Ordering::Acquire)) {
                    app.calibration_pending = None;
                    app.eval(&format!("window.hertzLyrics.calibrationDone({});",result));
                }
            }
            Event::UserEvent(UserEvent::Tray(event)) => app.handle_tray(event),
            Event::UserEvent(UserEvent::Menu(event)) => app.handle_menu(&event.id.0, target),
            Event::UserEvent(UserEvent::Native(event)) => app.handle_native(event, target),
            Event::UserEvent(UserEvent::Pipe(request)) => {
                if !request.admission.is_valid() {
                    return;
                }
                if request.body.get("protocol").is_some() || request.body.get("command").and_then(serde_json::Value::as_str).is_some_and(|command| command.starts_with("wallpaper.")) {
                    app.submit_wallpaper_management(request.body.clone(), ApiReply::Pipe(request.reply.clone(), request.admission.clone()), target);
                } else {
                    let response = app.handle_pipe_request(&request.body, target);
                    let _ = request.reply.send(response);
                }
            }
            Event::UserEvent(UserEvent::Host(action)) => {
                // 播放器进程内命令：复用同一套业务准入与分派，只是没有管道传输层。
                match action {
                    crate::host::HostAction::Settings(placement) => app.place_settings(placement, target),
                    crate::host::HostAction::Menu(id) => app.handle_menu(&id, target),
                    crate::host::HostAction::Command { body, reply } => {
                        if let Some(response) = app.handle_embedded_lyrics_request(&body) {
                            let _ = reply.send(response);
                        } else if body.get("protocol").is_some() || body.get("command").and_then(serde_json::Value::as_str).is_some_and(|command| command.starts_with("wallpaper.")) {
                            app.submit_wallpaper_management(body, ApiReply::Host(reply), target);
                        } else {
                            let response = app.handle_pipe_request(&body, target);
                            let _ = reply.send(response);
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Quit) => {
                app.cancel_calibration();
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::FeatureIdleExit) => {
                if app.can_finish_feature_exit() { *control_flow = ControlFlow::Exit; }
            }
            Event::WindowEvent {
                window_id, event, ..
            } => {
                if app.preview.as_ref().and_then(|preview| preview.surface.as_ref())
                    .is_some_and(|surface| surface.window.id()==window_id)
                    && matches!(&event, WindowEvent::CloseRequested) {
                    app.close_preview();
                } else if matches!(&event, WindowEvent::CloseRequested) && app.wallpaper_probe.close_window(window_id) {
                    // 探测窗口只取消它自己的 job；仍推进回收期限。
                } else if window_id == app.window.id() {
                    match event {
                        WindowEvent::CloseRequested => {
                            app.cancel_calibration();
                            *control_flow = ControlFlow::Exit;
                        }
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
                } else if app
                    .mini
                    .as_ref()
                    .is_some_and(|mini| mini.window.id() == window_id)
                {
                    match event {
                        WindowEvent::CloseRequested => {
                            let action = app.mini_host.handle(MiniEvent::Quit);
                            app.apply_mini_action(action, target);
                            app.sync_tray();
                        }
                        WindowEvent::ScaleFactorChanged { .. } => app.place_mini(),
                        _ => {}
                    }
                }
            }
            Event::LoopDestroyed => {
                app.cancel_calibration();
                app.close_preview();
                app.drop_wallpaper_surface();
                app.dbx = None;
                app.mini_runtime.stop.store(true, Ordering::Relaxed);
                // 还窗口过程并清注册表，避免收尾回调打在已销毁的窗上。
                if let Some(mini) = app.mini.take() {
                    mini_native::uninstall(mini.hwnd);
                }
                // 退出前注销本宿主全部全局快捷键（§5.1）。
                if let Some(manager) = app.hotkey.as_mut() {
                    if let Err(error) = manager.shutdown() {
                        log(&format!("hotkey shutdown incomplete: {error}"));
                    }
                }
                log("event loop destroyed");
            }
            _ => {}
        }
        if *control_flow != ControlFlow::Exit {
            app.sync_wallpaper_audio();
            let pointer_deadline = app.poll_wallpaper_pointer();
            if let Some(deadline) = app.source_expiry_deadline().into_iter()
                .chain(app.wallpaper_probe.next_deadline()).chain(pointer_deadline).min() {
                *control_flow = ControlFlow::WaitUntil(deadline);
            }
        }
            }
        };
    }
    if embedded {
        use tao::platform::run_return::EventLoopExtRunReturn;
        let _ = event_loop.run_return(event_loop_handler!());
        // 消息窗口是本进程单例，但接收方必须跟着这一轮宿主一起退役。
        native::clear_message_sink();
        Ok(())
    } else {
        event_loop.run(event_loop_handler!())
    }
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
        Some("triple") => Some(Layout::Triple),
        None => Some(match current {
            Layout::Double => Layout::Single,
            Layout::Single => Layout::Double,
            Layout::Triple => Layout::Single,
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
                        stop.clone(),
                        Instant::now(),
                        Box::new(Err(format!("{error:#}"))),
                    ));
                    return;
                }
            };
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let started = Instant::now();
                let update = feed.poll().map_err(|error| format!("{error:#}"));
                let failed = update.is_err();
                if stop.load(Ordering::Acquire) {
                    break;
                }
                if proxy
                    .send_event(UserEvent::Feed(
                        generation,
                        stop.clone(),
                        started,
                        Box::new(update),
                    ))
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
    // Near full-size windows must trade their outer margin for containment.
    // Capacity is already planned against the full work area, including panels.
    let horizontal_inset = inset.min((area.width() - width).max(0) / 2);
    let vertical_inset = inset.min((area.height() - height).max(0) / 2);
    let left = area.left + horizontal_inset;
    let top = area.top + vertical_inset;
    (
        snap(
            x,
            left,
            (area.right - width - horizontal_inset).max(left),
            inset,
        ),
        snap(
            y,
            top,
            (area.bottom - height - vertical_inset).max(top),
            inset,
        ),
    )
}

/// 窗口左边缘（物理像素）。锚点按名义最大宽度归一化，贴合只把窗口从参考边往里挪，
/// 所以它必须和 `lyrics_anchor_from_x` 互为逆运算，否则换句后的锚点会逐次漂移。
fn lyrics_left_x(area: &native::WorkArea, reference_width: i32, anchor: f64, offset: i32) -> i32 {
    let available = (area.width() - reference_width).max(0);
    area.left + (f64::from(available) * anchor).round() as i32 + offset
}

fn lyrics_anchor_from_x(area: &native::WorkArea, reference_width: i32, x: i32, offset: i32) -> f64 {
    let available = (area.width() - reference_width).max(1);
    (f64::from(x - offset - area.left) / f64::from(available)).clamp(0.0, 1.0)
}

/// 页面按当前这一句歌词量出来的窗口宽度（DIP，已含页面内边距）。
/// 没上报过时保持用户设定的宽度，上报值只允许往窄收、不允许超过上限。
fn lyrics_width_dip(reported: f64, reference: f64, max_width: f64) -> f64 {
    if !reported.is_finite() || reported <= 0.0 {
        return reference.min(max_width);
    }
    // 360 DIP 以下页面换成「两行槽」：贴合不该把宽窗口拖进那一档，否则收窄反而长高。
    let floor = if reference > 360.0 { 361.0 } else { 160.0 };
    reported.clamp(floor, reference.max(floor)).min(max_width)
}

/// 窗口朝哪一侧收：贴合掉的那段宽度留给歌词所在的一边，这样换句时字不跳。
fn lyrics_fit_offset(reference_width: i32, width: i32, align: LyricAlign) -> i32 {
    let slack = reference_width - width;
    if slack <= 0 {
        return 0;
    }
    match align {
        LyricAlign::Left => 0,
        LyricAlign::Right => slack,
        LyricAlign::Center => slack / 2,
    }
}

/// 歌词行高之外还要预留的窗口高度：工具条带 56 + 底部 14；
/// 多行布局的视口上下沿有渐隐遮罩，再让出 24，单行没有遮罩就不必留。
#[derive(Clone, Copy, Debug)]
struct VocalGeometry {
    capacity: usize,
    slot_height: f64,
    height: f64,
}

fn vocal_geometry(font_size: f64, measured_slot: f64, available_height: f64) -> VocalGeometry {
    let slot_height = (2.0 * 1.32 * font_size + 8.0)
        .ceil()
        .max(measured_slot.ceil());
    let capacity = ((available_height - 94.0 - 24.0) / slot_height)
        .floor()
        .clamp(0.0, 4.0) as usize;
    // A zero-slot window uses the existing empty-content height, constrained to
    // the work area. The saved font and placement anchor remain unchanged.
    let height = if capacity == 0 {
        130.0_f64.min(available_height.max(0.0))
    } else {
        94.0 + 24.0 + capacity as f64 * slot_height
    };
    VocalGeometry {
        capacity,
        slot_height,
        height,
    }
}

fn lyrics_work_area_changed(previous: &native::WorkArea, current: &native::WorkArea) -> bool {
    previous.name != current.name
        || previous.left != current.left
        || previous.top != current.top
        || previous.right != current.right
        || previous.bottom != current.bottom
        || previous.dpi != current.dpi
        || previous.primary != current.primary
}

fn lyrics_base_height_dip(lyrics: &LyricsConfig, width_dip: f64) -> f64 {
    let lines = match lyrics.layout {
        Layout::Double => 2.0,
        Layout::Single => 1.0,
        Layout::Triple => 3.0,
    };
    let factor = if width_dip <= 360.0 {
        if lyrics.bilingual {
            4.5
        } else {
            3.25
        }
    } else if lyrics.bilingual {
        2.55
    } else {
        2.0
    };
    let chrome = if lyrics.layout == Layout::Single {
        70.0
    } else {
        94.0
    };
    lyrics.font_size * factor * lines + chrome
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

fn monitor_geometry_changed(
    left: &native::WallpaperMonitor,
    right: &native::WallpaperMonitor,
) -> bool {
    left.left != right.left
        || left.top != right.top
        || left.width != right.width
        || left.height != right.height
        || left.dpi != right.dpi
        || left.refresh_hz != right.refresh_hz
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
        .map(|profile| serde_json::to_value(profile).unwrap())
        .collect()
}

fn validate_candidate(candidate: &WallpaperCandidate) -> Result<(), String> {
    candidate.normalized().map(|_| ())
}

/// ADR-0006 整数分频：N=max(1,ceil(refreshHz/targetFps))，有效预算=refreshHz/N。
/// 与壁纸页 wallpaper-scene.js 的 computeGate 保持同一公式。
fn frame_divisor(fps: u8, refresh_hz: u32) -> (u32, f64) {
    let hz = if refresh_hz >= 5 {
        f64::from(refresh_hz)
    } else {
        60.0
    };
    let target = f64::from(fps.max(1));
    let divisor = ((hz / target).ceil() as u32).max(1);
    (divisor, hz / f64::from(divisor))
}

fn new_lease_id() -> Result<String, String> {
    crate::wallpaper::file_tokens::random_token().map_err(|error| error.message)
}

/// 按稳定身份优先、GDI 名次序解析目标显示器（设计 §2.2-9）。
#[cfg(test)]
fn resolve_wallpaper_monitor(
    monitors: &[native::WallpaperMonitor],
    wallpaper: &config::WallpaperConfig,
) -> Option<native::WallpaperMonitor> {
    match &wallpaper.main().displays[0] {
        crate::wallpaper::config::DisplaySelection::Fixed { display_id } => monitors
            .iter()
            .find(|monitor| monitor.display_id() == *display_id)
            .cloned(),
        crate::wallpaper::config::DisplaySelection::Primary => {
            monitors.iter().find(|monitor| monitor.primary).cloned()
        }
        crate::wallpaper::config::DisplaySelection::Unresolved { .. } => None,
    }
}

#[cfg(test)]
fn resolve_wallpaper_monitor_or_primary(
    monitors: &[native::WallpaperMonitor],
    wallpaper: &config::WallpaperConfig,
) -> Option<native::WallpaperMonitor> {
    resolve_wallpaper_monitor(monitors, wallpaper)
}

#[allow(clippy::too_many_arguments)]
fn create_resolved_presentation(
    target: &EventLoopWindowTarget<()>,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    revision: u64,
    configuration: config::WallpaperConfig,
    builtin: Option<crate::wallpaper::config::BuiltinState>,
    composition: Option<crate::wallpaper::composition_plan::PreparedComposition>,
    monitor: native::WallpaperMonitor,
    presentation: PresentationWindow,
) -> Result<WallpaperSurface> {
    // Budget and page initialization use the verified scene; the surface keeps
    // the saved fixed-version intent for CAS and retirement reference tracking.
    let mut rendering = configuration.clone();
    if let Some(state) = builtin {
        rendering.main_mut().selection = crate::wallpaper::config::Selection::Builtin {
            scene_id: state.scene_id,
            state_version: state.state_version,
            params: state.params,
        };
    }
    let mut surface = create_presentation(
        target,
        proxy,
        generation,
        revision,
        rendering,
        monitor,
        presentation,
        composition,
    )?;
    surface.configuration = configuration;
    Ok(surface)
}

#[allow(clippy::too_many_arguments)]
fn create_presentation(
    target: &EventLoopWindowTarget<()>,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    revision: u64,
    configuration: config::WallpaperConfig,
    monitor: native::WallpaperMonitor,
    presentation: PresentationWindow,
    composition: Option<crate::wallpaper::composition_plan::PreparedComposition>,
) -> Result<WallpaperSurface> {
    use crate::wallpaper::session::{RecoveryLedger, WallpaperSession};
    let is_preview = matches!(presentation, PresentationWindow::Preview { .. });
    let mut session = if is_preview {
        WallpaperSession::preview_after_generation(generation.saturating_sub(1))
    } else {
        WallpaperSession::after_generation(generation.saturating_sub(1))
    };
    let session_generation = session
        .apply(revision, &RecoveryLedger::new())
        .map_err(|_| anyhow::anyhow!("壁纸会话无法开始"))?;
    debug_assert_eq!(session_generation, generation);
    session.resolved(generation);
    session.prepared(generation);
    let binding = crate::wallpaper::page_events::PageBinding::new(generation)
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let media_access = crate::wallpaper::access::MediaAccess::new();
    let gl = if configuration.builtin().is_some() || composition.is_some() {
        use crate::wallpaper::{
            budget,
            gl_plan::{GlAdmission, GlPlan},
        };
        let budget = budget::global();
        let owner = if is_preview {
            budget::OwnerKind::Preview
        } else {
            budget::OwnerKind::Desktop
        };
        let plan = if let Some(composition) = &composition {
            let target_changed = if let Some(plan) = composition.builtin_target() {
                let facts = &plan.target_facts;
                facts.monitor_id != monitor.display_id()
                    || facts.refresh_hz != monitor.refresh_hz
                    || facts.monitor_left != monitor.left
                    || facts.monitor_top != monitor.top
                    || facts.physical_width != monitor.width.max(1) as u32
                    || facts.physical_height != monitor.height.max(1) as u32
                    || native::verified_wallpaper_monitor_dpi(&monitor)
                        .is_none_or(|dpi| f64::from(dpi) / 96.0 != facts.device_scale)
                    || facts.requested_quality != configuration.presentation().quality.as_str()
                    || facts.requested_fps.min(if is_preview { 15 } else { 60 })
                        != u32::from(configuration.presentation().fps)
            } else {
                composition.target().width != monitor.width.max(1) as u32
                    || composition.target().height != monitor.height.max(1) as u32
            };
            if target_changed || composition.output_fit() != configuration.presentation().fit {
                bail!("组合目标已变化，需要重新准备和准入");
            }
            composition.gl_plan(
                owner,
                format!("composition-{generation}"),
                generation,
                monitor.refresh_hz,
                u32::from(configuration.presentation().fps),
            )?
        } else {
            GlPlan::new(
                &budget.usage(),
                owner,
                format!(
                    "gl-{}-{generation}",
                    if is_preview { "preview" } else { "desktop" }
                ),
                generation,
                monitor.width.max(1) as u32,
                monitor.height.max(1) as u32,
                monitor.refresh_hz,
                u32::from(configuration.presentation().fps),
                configuration.presentation().quality.as_str(),
            )?
        };
        let mut admission = GlAdmission::new(plan, budget)?;
        if let Some(composition) = composition {
            admission.bind_composition(composition, &media_access, binding.session_id())?;
        }
        Some(admission)
    } else {
        None
    };
    let gl_script = gl
        .as_ref()
        .map_or_else(String::new, |gl| gl.initialization_script());
    let page: Arc<[u8]> = Arc::from(wallpaper_html().into_bytes());
    let page_bytes = page.len();
    let mut builder = WindowBuilder::new()
        .with_title(if is_preview {
            "壁纸预览"
        } else {
            "Hertz wallpaper"
        })
        .with_inner_size(PhysicalSize::new(
            monitor.width.max(1) as u32,
            monitor.height.max(1) as u32,
        ))
        .with_position(PhysicalPosition::new(monitor.left, monitor.top))
        .with_decorations(is_preview)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false);
    if let PresentationWindow::Preview { owner, embedded } = presentation {
        builder = if embedded {
            builder
                .with_parent_window(owner as _)
                .with_decorations(false)
        } else {
            builder.with_owner_window(owner as _)
        };
    }
    let window = builder.build(target)?;
    let hwnd = window.hwnd() as HWND;
    if is_preview
        || matches!(
            presentation,
            PresentationWindow::Desktop { candidate: true }
        )
    {
        native::wallpaper_opacity(hwnd, 1)?;
    }
    if is_preview {
        let size = window.inner_size();
        if size.width != monitor.width as u32 || size.height != monitor.height as u32 {
            bail!("原生预览窗口与固定输出尺寸不匹配");
        }
        window.set_visible(true);
    } else {
        native::mount_wallpaper(hwnd, &monitor)?;
    }
    let child_rect =
        native::window_rect(hwnd).map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
    let parent_rect =
        native::parent_window_rect(hwnd).map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
    let window_dpi = native::window_dpi(hwnd);
    let zoom = f64::from(monitor.dpi) / f64::from(window_dpi.max(1));
    let page_proxy = proxy.clone();
    let mut web_context = WebContext::new(Some(config::webview_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_initialization_script(binding.initialization_script())
        .with_initialization_script(gl_script)
        .with_initialization_script(format!(
            "window.__hertzWallpaperNativePointer = {};",
            !is_preview
        ))
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
    // 媒体拦截：wallpaper.invalid 保留域 → 本机 IStream（§8.1）。
    let media_access =
        crate::wallpaper::webresource::install_with_access(&webview, proxy.clone(), media_access)
            .map_err(|error| anyhow::anyhow!("安装壁纸媒体拦截失败：{error}"))?;
    if (zoom - 1.0).abs() > 0.001 {
        webview
            .zoom(zoom)
            .map_err(|error| anyhow::anyhow!("应用壁纸 DPI 缩放失败：{error}"))?;
    }
    log(&format!(
        "wallpaper target name={} rect={},{} {}x{} dpi={} window_dpi={window_dpi} zoom={zoom:.3} page_bytes={page_bytes} child={child_rect:?} parent={parent_rect:?}",
        monitor.name, monitor.left, monitor.top, monitor.width, monitor.height, monitor.dpi
    ));
    // Publishing transfers the already-reserved GL envelope to the Close barrier.
    // Construction cannot receive any host mount/start command before this point.
    if let Some(gl) = gl {
        session.admit_gl(gl)?;
    }
    session.native_attached(generation);
    Ok(WallpaperSurface {
        page_clock: None,
        pointer: wallpaper_pointer::Input::default(),
        session,
        binding,
        created_at: Instant::now(),
        frame_wait_since: None,
        static_poster: false,
        runtime_builtin: configuration.builtin(),
        runtime_reference: None,
        playlist_token: None,
        mirror_source_generation: None,
        configuration,
        window,
        webview,
        _web_context: web_context,
        monitor,
        zoom,
        eval_failures: AtomicU64::new(0),
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        close_probe_blocked: false,
        _media_access: media_access,
    })
}

fn create_settings(
    target: &EventLoopWindowTarget<()>,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    placement: Option<crate::settings_embedding::SettingsPlacement>,
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
    let mut builder = WindowBuilder::new()
        .with_title("桌面歌词与壁纸")
        .with_window_icon(Some(icon.clone()))
        .with_taskbar_icon(Some(icon))
        .with_inner_size(tao::dpi::LogicalSize::new(width, height))
        .with_min_inner_size(tao::dpi::LogicalSize::new(320.0, 420.0))
        .with_resizable(true)
        .with_visible(placement.is_none());
    if let Some(placement) = &placement {
        builder = builder
            .with_parent_window(placement.parent as _)
            .with_decorations(false)
            .with_resizable(false)
            .with_focused(false)
            .with_skip_taskbar(true)
            .with_undecorated_shadow(false)
            .with_min_inner_size(tao::dpi::PhysicalSize::new(1, 1))
            .with_inner_size(PhysicalSize::new(
                placement.bounds.width,
                placement.bounds.height,
            ))
            .with_position(PhysicalPosition::new(
                placement.bounds.x,
                placement.bounds.y,
            ));
    }
    let window = builder.build(target)?;
    let page_proxy = proxy.clone();
    let settings_page = settings_html().into_bytes();
    let mut web_context = WebContext::new(Some(config::webview_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
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
                _ => None,
            };
            Response::builder()
                .status(if page.is_some() { 200 } else { 404 })
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Cow::Owned(page.cloned().unwrap_or_default()))
                .unwrap()
        })
        .with_url("hertz://localhost/settings.html")
        .with_initialization_script(if placement.is_some() {
            "window.__hertzEmbeddedSettings = true;"
        } else {
            ""
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_background_color((20, 20, 19, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= hertz_desktop_ipc::management::REQUEST_LIMIT {
                let _ = page_proxy.send_event(UserEvent::SettingsPage(generation, body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建设置 WebView 失败：{error}"))?;
    Ok(SettingsSurface {
        window,
        webview: Rc::new(webview),
        _web_context: web_context,
        placement,
        preview_bounds: None,
        ready: false,
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
    include_str!("../assets/wallpaper-settings.html")
        .replace(
            "__EMBEDDED_CSS__",
            include_str!("../assets/wallpaper-embedded.css"),
        )
        .replace(
            "__DISPLAYS_CSS__",
            include_str!("../assets/wallpaper-displays.css"),
        )
        .replace(
            "__DISPLAYS__",
            include_str!("../assets/wallpaper-displays.js"),
        )
        .replace(
            "__SETTINGS__",
            include_str!("../assets/wallpaper-settings.js"),
        )
        .replace(
            "__LIBRARY__",
            include_str!("../assets/wallpaper-library.js"),
        )
        .replace("__WORKS__", include_str!("../assets/wallpaper-work.js"))
        .replace("__AI_CSS__", include_str!("../assets/wallpaper-ai.css"))
        .replace("__AI__", include_str!("../assets/wallpaper-ai.js"))
        .replace(
            "__PLAYLIST__",
            include_str!("../assets/wallpaper-playlist.js"),
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
            "__GL_BUDGET__",
            &format!(
                "{}\n{}",
                include_str!("../../../plugin/ui/stage-resource-budget.js"),
                include_str!("../assets/wallpaper-gl-budget.js")
            ),
        )
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
                    if stop.load(Ordering::Acquire) {
                        return false;
                    }
                    if !received {
                        log(&format!("wallpaper events connected seq={}", snapshot.seq));
                    }
                    received = true;
                    proxy
                        .send_event(UserEvent::WallpaperFeed(
                            generation,
                            stop.clone(),
                            Instant::now(),
                            Box::new(Ok(snapshot)),
                        ))
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
                        let _ = proxy.send_event(UserEvent::WallpaperFeed(
                            generation,
                            stop.clone(),
                            Instant::now(),
                            Box::new(Err(error)),
                        ));
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
    stop: &Arc<AtomicBool>,
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let started = Instant::now();
        let result = feed.poll();
        let failed = result.is_err();
        if stop.load(Ordering::Acquire) {
            break;
        }
        if proxy
            .send_event(UserEvent::WallpaperFeed(
                generation,
                stop.clone(),
                started,
                Box::new(result),
            ))
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

fn parse_page_clock(event: &str) -> Option<PageClock> {
    PageClock::new(event.strip_prefix("wallpaper_clock ")?.parse().ok()?)
}
fn wallpaper_payload(
    snapshot: &WallpaperSnapshot,
    clock: Option<PageClock>,
) -> Result<String, serde_json::Error> {
    let mut value = serde_json::to_value(snapshot)?;
    if let Some(started) = snapshot.received_at {
        let now = Instant::now();
        value["snapshotAgeMs"] = (now.saturating_duration_since(started).as_millis() as u64).into();
        if let Some(clock) = clock {
            value["pageDispatchMs"] = serde_json::json!(clock.at(now));
        }
    }
    serde_json::to_string(&value)
}

fn default_profile() -> Profile {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hertz-studio");
    config::standalone(dir, "full")
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

/// 小窗页面：三件套占位符拼装（html 里的注释说明了这一手法）。
fn mini_page_html() -> String {
    include_str!("../assets/mini-player.html")
        .replace("__MINI_CSS__", include_str!("../assets/mini-player.css"))
        .replace("__MINI_JS__", include_str!("../assets/mini-player.js"))
}

const MINI_PAGE_PATH: &str = "/mini-player.html";
const MINI_PAGE_URL: &str = "hertz://localhost/mini-player.html";
/// 皮肤文件单上限。pet.json + 若干帧，8MB 足够任何合理的精灵序列。
const MINI_SKIN_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 打开（并初始化）桌宠素材文件夹时落一份约定说明。
const PET_ASSETS_README: &str = r#"Hertz 桌面宠物 · 素材约定
========================

把这个文件夹里的图片作为你的桌面宠物：小窗开着时增删或替换文件，宠物几秒内自动换装
（若没刷新，托盘里关掉再勾上一次小窗即可）。

文件命名（全部小写）：
  idle.png            待机/暂停时的形象（单帧）
  playing-1.png       播放中的动画帧，按序号循环：playing-1.png / playing-2.png / ...
  dragging.png        按住宠物拖动时的形象（可选）
  tap.png             点击播放/暂停、切曲时蹦一下的一次性动画（可选，默认不循环）
  pet.json            可选清单，示例：
                      {"name":"我的宠物","size":[96,96],
                       "states":{"playing":{"fps":8,"frames":["playing-1.png","playing-2.png"]}}}

支持 PNG / JPG / WebP / GIF / SVG（SVG 请自带 width/height，或在 pet.json 里写 size）。
推荐 56~128 见方、透明背景。某个状态没提供时自动回退 idle，全部缺失时回退内置形象。

状态清单：idle（待机/暂停）· playing（播放中）· dragging（拖拽）· tap（点按反应）
"#;

fn create_mini(
    target: &EventLoopWindowTarget<()>,
    proxy: EventLoopProxy<UserEvent>,
    cover: MiniCover,
) -> Result<MiniSurface> {
    let icon = window_icon()?;
    let window = WindowBuilder::new()
        .with_title("Hertz 小窗")
        .with_window_icon(Some(icon))
        .with_decorations(false)
        .with_transparent(true)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .build(target)?;
    let hwnd = window.hwnd() as HWND;
    let page = mini_page_html().into_bytes();
    let cover_in_handler = Arc::clone(&cover);
    let page_proxy = proxy.clone();
    let mut web_context = WebContext::new(Some(config::webview_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_transparent(true)
        // 页面要 fetch 同源的皮肤文件（pet.json / 帧图片），NavigateToString 的
        // origin 取不到 hertz://，所以整页走自定义协议（与壁纸/设置窗同一招）。
        .with_custom_protocol(WALLPAPER_PROTOCOL.to_string(), move |_id, request| {
            mini_protocol_response(&page, request.uri().path(), &cover_in_handler)
        })
        .with_url(MINI_PAGE_URL)
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 4096 {
                let _ = page_proxy.send_event(UserEvent::MiniPage(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建小窗 WebView 失败：{error}"))?;
    Ok(MiniSurface {
        window,
        webview,
        _web_context: web_context,
        hwnd,
    })
}

/// 小窗 origin 的白名单：页面本身、皮肤文件、最新一帧封面。其余一律 404，
/// 不做通用文件服务（与壁纸页同一原则）。
fn mini_protocol_response(
    page: &[u8],
    path: &str,
    cover: &MiniCover,
) -> Response<Cow<'static, [u8]>> {
    if path == MINI_PAGE_PATH {
        return Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Cow::Owned(page.to_vec()))
            .unwrap();
    }
    if path == "/mini-cover" {
        let guard = cover.lock().unwrap_or_else(|error| error.into_inner());
        return match guard.as_ref() {
            Some((_, bytes, mime)) => Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, mime.clone())
                .body(Cow::Owned(bytes.clone()))
                .unwrap(),
            None => Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b""[..]))
                .unwrap(),
        };
    }
    match mini_skin_file(path.strip_prefix("/mini-skin/")) {
        Some((bytes, mime)) => Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, mime)
            // 皮肤可能被用户替换：组件重开窗口时必须拿到新文件。
            .header(header::CACHE_CONTROL, "no-store")
            .body(Cow::Owned(bytes))
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b""[..]))
            .unwrap(),
    }
}

/// 皮肤文件：数据目录 `pet/` 下按严格白名单取名。`..`、绝对路径、大写、
/// 超限体积全部拒绝——这个 handler 离文件系统只有一步，准入必须谨慎。
fn mini_skin_file(name: Option<&str>) -> Option<(Vec<u8>, &'static str)> {
    let name = name?;
    if name.is_empty() || name.len() > 96 || name.contains("..") {
        return None;
    }
    if !name.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '-' | '_' | '.')
    }) {
        return None;
    }
    let mime = match name.rsplit('.').next()? {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "json" => "application/json; charset=utf-8",
        _ => return None,
    };
    let bytes = std::fs::read(config::base_dir().join("pet").join(name)).ok()?;
    if bytes.len() > MINI_SKIN_MAX_BYTES {
        return None;
    }
    Some((bytes, mime))
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

/// 小窗来源线程：轮询快照 + 播放中 4Hz 推位置。节奏由事件侧通过共享量调节，
/// 线程自己不认识相位（与歌词 feed 的 generation 模式同源）。
fn spawn_mini_feed(
    profile: Profile,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    runtime: MiniRuntime,
) {
    std::thread::Builder::new()
        .name("hertz-mini-feed".into())
        .spawn(move || {
            let mut feed = match crate::mini_feed::MiniFeed::new(profile) {
                Ok(feed) => feed,
                Err(error) => {
                    log(&format!("mini feed unavailable: {error:#}"));
                    return;
                }
            };
            loop {
                if runtime.stop.load(Ordering::Relaxed) {
                    break;
                }
                let started = Instant::now();
                let result = feed.poll().map_err(|error| format!("{error:#}"));
                if proxy
                    .send_event(UserEvent::MiniFeed(generation, started, Box::new(result)))
                    .is_err()
                {
                    break;
                }
                let interval =
                    Duration::from_millis(runtime.poll_hint_ms.load(Ordering::Relaxed).max(250));
                let deadline = Instant::now() + interval;
                while Instant::now() < deadline {
                    if runtime.stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    // 播放中的位置由组件侧呈现时钟推 4Hz，页面不做二次插值。
                    if runtime.visible.load(Ordering::Relaxed) && feed.clock().playing() {
                        let ms = feed.clock().now_ms();
                        if proxy
                            .send_event(UserEvent::MiniPosition(generation, ms))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
        })
        .ok();
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

pub(crate) struct Args {
    pub(crate) data_dir: Option<PathBuf>,
    pub(crate) locate: bool,
    pub(crate) wallpaper_feed_test: bool,
    pub(crate) wallpaper: bool,
    pub(crate) settings: bool,
    /// 进程内宿主可指定首次打开的设置页签；CLI 不暴露这个参数。
    pub(crate) settings_tab: Option<String>,
    pub(crate) preview: bool,
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
            settings_tab: None,
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
        config::standalone(PathBuf::from(dir), "full")
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
            refresh_hz: 144,
            device_path: None,
            edid_digest: None,
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
    fn vocal_window_placement_relaxes_margin_when_work_area_has_little_slack() {
        for dpi in [96, 144, 192] {
            let scale = f64::from(dpi) / 96.0;
            for panel in [0.0, 136.0] {
                for slack in 0..=31 {
                    let available = 470.0 + f64::from(slack);
                    let geometry = vocal_geometry(30.0, 0.0, available);
                    assert_eq!(geometry.capacity, 4);
                    let height = ((geometry.height + panel) * scale).round() as i32;
                    let area = native::WorkArea {
                        name: "constrained".into(),
                        left: -1200,
                        top: -100,
                        right: -1200 + (550.0 * scale).round() as i32,
                        bottom: -100 + ((available + panel) * scale).round() as i32,
                        dpi,
                        primary: false,
                    };
                    let width = area.width();
                    for (x, y) in [(-5000, -5000), (5000, 5000), (area.left, area.top)] {
                        let (left, top) = bounded_lyrics_position(x, y, width, height, &area);
                        assert!(left >= area.left && left + width <= area.right);
                        assert!(top >= area.top && top + height <= area.bottom);
                    }
                }
            }
            let tiny = native::WorkArea {
                name: "tiny".into(),
                left: 0,
                top: 0,
                right: 240,
                bottom: (40.0 * scale).round() as i32,
                dpi,
                primary: true,
            };
            let empty = vocal_geometry(72.0, 0.0, 40.0);
            assert_eq!(empty.capacity, 0);
            assert_eq!(
                bounded_lyrics_position(100, 100, tiny.width(), tiny.height(), &tiny),
                (0, 0)
            );
        }
    }

    #[test]
    fn lyric_window_fits_content_without_exceeding_the_saved_width() {
        assert_eq!(lyrics_width_dip(0.0, 900.0, 2304.0), 900.0);
        assert_eq!(lyrics_width_dip(f64::NAN, 900.0, 2304.0), 900.0);
        assert_eq!(lyrics_width_dip(262.0, 900.0, 2304.0), 361.0);
        assert_eq!(lyrics_width_dip(1400.0, 900.0, 2304.0), 900.0);
        assert_eq!(lyrics_width_dip(2600.0, 2400.0, 2304.0), 2304.0);
        // 用户本来就把上限压进窄栏档时，贴合可以继续往窄收。
        assert_eq!(lyrics_width_dip(262.0, 340.0, 2304.0), 262.0);
        assert_eq!(lyrics_width_dip(80.0, 340.0, 2304.0), 160.0);
    }

    #[test]
    fn lyric_base_height_only_reserves_the_toolbar_band_and_mask_slack() {
        let lyrics = LyricsConfig::default();
        assert_eq!(lyrics_base_height_dip(&lyrics, 550.0), 130.0);
        assert_eq!(lyrics_base_height_dip(&lyrics, 320.0), 30.0 * 3.25 + 70.0);
        let bilingual = LyricsConfig {
            bilingual: true,
            layout: Layout::Double,
            ..Default::default()
        };
        assert_eq!(
            lyrics_base_height_dip(&bilingual, 900.0),
            30.0 * 2.55 * 2.0 + 94.0
        );
    }

    #[test]
    fn vocal_geometry_capacity_uses_work_area_font_and_panel_budget() {
        for font in [18.0, 30.0, 72.0] {
            let h = (2.0_f64 * 1.32 * font + 8.0).ceil();
            for slots in 1..=4 {
                let area = 94.0 + 24.0 + slots as f64 * h;
                let geometry = vocal_geometry(font, 0.0, area);
                assert_eq!(geometry.capacity, slots);
                assert_eq!(geometry.slot_height, h);
                assert_eq!(geometry.height, area);
                assert_eq!(vocal_geometry(font, 0.0, area - 1.0).capacity, slots - 1);
            }
            assert_eq!(vocal_geometry(font, 0.0, 2000.0).capacity, 4);
            let constrained = vocal_geometry(font, 0.0, 40.0);
            assert_eq!(constrained.capacity, 0);
            assert_eq!(constrained.height, 40.0);
        }
        let measured = vocal_geometry(30.0, 120.0, 598.0);
        assert_eq!(measured.slot_height, 120.0);
        assert_eq!(measured.capacity, 4);
        assert_eq!(vocal_geometry(30.0, 120.0, 597.0).capacity, 3);
        // A 200 DIP expanded panel consumes the same budget at every DPI.
        for dpi in [96.0, 144.0, 192.0] {
            let work_area_physical = 600.0 * dpi / 96.0;
            let logical_remaining = work_area_physical / (dpi / 96.0) - 200.0;
            assert_eq!(vocal_geometry(30.0, 0.0, logical_remaining).capacity, 3);
        }
    }

    #[test]
    fn lyric_work_area_shrink_replans_even_while_old_center_remains_inside() {
        let original = native::WorkArea {
            name: "main".into(),
            left: 0,
            top: 0,
            right: 550,
            bottom: 1000,
            dpi: 96,
            primary: true,
        };
        let smaller = native::WorkArea {
            bottom: 400,
            ..original.clone()
        };
        let center = windows_sys::Win32::Foundation::POINT { x: 275, y: 235 };
        assert!(native::point_in_work_area(center, &original));
        assert!(native::point_in_work_area(center, &smaller));
        assert!(lyrics_work_area_changed(&original, &smaller));
        assert_eq!(
            vocal_geometry(30.0, 0.0, original.height() as f64).capacity,
            4
        );
        let constrained = vocal_geometry(30.0, 0.0, smaller.height() as f64);
        assert_eq!(constrained.capacity, 3);
        assert_eq!(constrained.height, 382.0);
        assert!(!lyrics_work_area_changed(&smaller, &smaller.clone()));
        for changed in [
            native::WorkArea {
                dpi: 144,
                ..smaller.clone()
            },
            native::WorkArea {
                left: 5,
                ..smaller.clone()
            },
            native::WorkArea {
                name: "other".into(),
                ..smaller.clone()
            },
        ] {
            assert!(lyrics_work_area_changed(&smaller, &changed));
        }
    }

    #[test]
    fn lyric_fit_keeps_the_aligned_edge_and_the_anchor_together() {
        let area = native::WorkArea {
            name: "main".into(),
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1528,
            dpi: 144,
            primary: true,
        };
        let (reference, fitted) = (1350, 400);
        let edge = |x: i32, width: i32, align: LyricAlign| match align {
            LyricAlign::Left => x,
            LyricAlign::Center => x + width / 2,
            LyricAlign::Right => x + width,
        };
        for align in [LyricAlign::Left, LyricAlign::Center, LyricAlign::Right] {
            for anchor in [0.0_f64, 0.37, 1.0] {
                let offset = lyrics_fit_offset(reference, fitted, align);
                let wide = lyrics_left_x(&area, reference, anchor, 0);
                let narrow = lyrics_left_x(&area, reference, anchor, offset);
                assert_eq!(
                    edge(wide, reference, align),
                    edge(narrow, fitted, align),
                    "{align:?} @{anchor}"
                );
                let saved = lyrics_anchor_from_x(&area, reference, narrow, offset);
                assert!(
                    (saved - anchor).abs() < 0.002,
                    "{align:?} @{anchor} -> {saved}"
                );
            }
        }
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

    fn policy_inputs(
        enabled: bool,
        manual_pause: bool,
        display_missing: bool,
        has_surface: bool,
        page_ready: bool,
    ) -> policy::PolicyInputs<'static> {
        policy::PolicyInputs {
            enabled,
            wallpaper: Box::leak(Box::new(config::WallpaperConfig::default())),
            manual_pause,
            fullscreen: false,
            maximized: false,
            application_rule: None,
            session_unavailable: false,
            display_off: false,
            display_missing,
            power: native::PowerState::Ac,
            has_surface,
            page_ready,
        }
    }

    #[test]
    fn pause_reasons_report_each_gate() {
        let inputs = policy_inputs(true, false, false, true, true);
        assert!(policy::pause_reasons(&inputs).is_empty());
        assert_eq!(
            policy::pause_reasons(&policy_inputs(false, false, false, false, false)),
            vec!["disabled"]
        );
        assert_eq!(
            policy::pause_reasons(&policy_inputs(true, true, false, true, true)),
            vec!["manualPause"]
        );
        assert_eq!(
            policy::pause_reasons(&policy_inputs(true, false, true, false, false)),
            vec!["displayMissing", "noSurface"]
        );
        assert_eq!(
            policy::pause_reasons(&policy_inputs(true, false, false, false, false)),
            vec!["noSurface"]
        );
        assert_eq!(
            policy::pause_reasons(&policy_inputs(true, false, false, true, false)),
            vec!["pageNotReady"]
        );
        let mut paused = policy_inputs(true, false, false, true, true);
        paused.fullscreen = true;
        paused.session_unavailable = true;
        paused.display_off = true;
        assert_eq!(
            policy::pause_reasons(&paused),
            vec!["fullscreen", "sessionUnavailable", "displayOff"]
        );
        assert!(!policy::renderable(&paused));
        assert!(policy::renderable(&inputs));
    }

    #[test]
    fn frame_divisor_follows_integer_split_rule() {
        // ADR-0006：N=ceil(hz/target)，有效预算=hz/N；刷新率未知按 60。
        assert_eq!(frame_divisor(30, 144), (5, 28.8));
        assert_eq!(frame_divisor(60, 144), (3, 48.0));
        assert_eq!(frame_divisor(30, 60), (2, 30.0));
        assert_eq!(frame_divisor(60, 60), (1, 60.0));
        assert_eq!(frame_divisor(30, 75), (3, 25.0));
        assert_eq!(frame_divisor(15, 0), (4, 15.0));
    }

    #[test]
    fn wallpaper_candidate_accepts_v4_fields_and_rejects_out_of_range() {
        let base = serde_json::json!({
            "enabled": true, "fps": 30, "musicResponse": true,
            "monitor": null, "source": "fixed", "scene": "zodiac"
        });
        // 旧载荷（无 v4 字段）按默认值通过。
        let legacy: WallpaperCandidate =
            serde_json::from_value(base.clone()).expect("legacy candidate");
        assert_eq!(
            legacy.normalized().unwrap().presentation().quality,
            config::WallpaperQuality::Low
        );
        assert_eq!(legacy.normalized().unwrap().presentation().brightness, 1.0);
        assert_eq!(legacy.normalized().unwrap().presentation().motion, 1.0);
        assert!(validate_candidate(&legacy).is_ok());
        let mut full = base.clone();
        full["brightness"] = 0.5.into();
        full["motion"] = 0.25.into();
        full["quality"] = "high".into();
        full["batteryPolicy"] = "pause".into();
        let full: WallpaperCandidate = serde_json::from_value(full).expect("v4 candidate");
        assert!(validate_candidate(&full).is_ok());
        let mut bad = full.normalized().unwrap();
        bad.main_mut().presentation.brightness = 0.1;
        assert!(validate_candidate(&WallpaperCandidate::Current(bad)).is_err());
        let mut bad = full.normalized().unwrap();
        bad.main_mut().presentation.motion = 1.5;
        assert!(validate_candidate(&WallpaperCandidate::Current(bad)).is_err());
        let mut bad = full.normalized().unwrap();
        bad.main_mut().presentation.fps = 45;
        assert!(validate_candidate(&WallpaperCandidate::Current(bad)).is_err());
    }

    #[test]
    fn monitor_resolution_prefers_display_id_then_legacy_name() {
        let monitors = vec![monitor()];
        // 无身份记录：无名字匹配 → None（不猜另一块屏）。
        let wallpaper = config::LegacyWallpaperConfig {
            monitor: Some(r"\\.\DISPLAY9".into()),
            ..Default::default()
        }
        .migrate(&monitors, false)
        .unwrap();
        assert!(resolve_wallpaper_monitor(&monitors, &wallpaper).is_none());
        // 旧 GDI 名命中。
        let wallpaper = config::LegacyWallpaperConfig {
            monitor: Some(r"\\.\DISPLAY1".into()),
            ..Default::default()
        }
        .migrate(&monitors, false)
        .unwrap();
        assert!(resolve_wallpaper_monitor(&monitors, &wallpaper).is_some());
        // 已有稳定身份时等待原屏，不能认领复用 GDI 名的新屏。
        let wallpaper = config::LegacyWallpaperConfig {
            monitor: Some(r"\\.\DISPLAY1".into()),
            display_id: Some("future-identity".into()),
            ..Default::default()
        }
        .migrate(&monitors, false)
        .unwrap();
        assert!(resolve_wallpaper_monitor(&monitors, &wallpaper).is_none());
        let wallpaper = config::LegacyWallpaperConfig {
            monitor: Some(r"\\.\DISPLAY9".into()),
            display_id: Some("future-identity".into()),
            ..Default::default()
        }
        .migrate(&monitors, false)
        .unwrap();
        assert!(resolve_wallpaper_monitor(&monitors, &wallpaper).is_none());
        assert!(resolve_wallpaper_monitor_or_primary(&monitors, &wallpaper).is_none());
        assert!(resolve_wallpaper_monitor_or_primary(&monitors, &Default::default()).is_some());
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
        let candidate = config::standalone(PathBuf::from(r"C:\profiles\c"), "standard");
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
        assert_eq!(
            layout_choice(Some("triple"), Layout::Double),
            Some(Layout::Triple)
        );
        assert_eq!(layout_choice(Some("unknown"), Layout::Double), None);
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
