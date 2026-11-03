// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    frame_window::FrameWindow,
    handoff::{CaptureHold, CAPTURE_PREFIX},
};

pub(super) struct Handoff {
    pub(super) hold: CaptureHold,
    pub(super) window: Option<FrameWindow>,
    pub(super) configuration: config::WallpaperConfig,
    pub(super) applied_revision: Option<u64>,
    pub(super) runtime_builtin: Option<crate::wallpaper::config::BuiltinState>,
    monitor: native::WallpaperMonitor,
    preview_owner: Option<HWND>,
    retiring: bool,
    pub(super) reveal: Option<(u64, Instant)>,
}
impl Handoff {
    pub(super) fn begin(
        surface: &WallpaperSurface,
        preview_owner: Option<HWND>,
    ) -> Result<(Self, String)> {
        let mut monitor = surface.monitor.clone();
        if preview_owner.is_some() {
            let mut origin = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            if unsafe {
                windows_sys::Win32::Graphics::Gdi::ClientToScreen(surface.hwnd(), &mut origin)
            } == 0
            {
                bail!("读取预览位置失败");
            }
            monitor.left = origin.x;
            monitor.top = origin.y;
        }
        let budget = crate::wallpaper::budget::global();
        let mut hold = if preview_owner.is_some() {
            CaptureHold::reserve_for(
                budget,
                &surface.binding,
                monitor.width as u32,
                monitor.height as u32,
                true,
            )?
        } else {
            CaptureHold::reserve(
                budget,
                &surface.binding,
                monitor.width as u32,
                monitor.height as u32,
            )?
        };
        let script = hold.issue_script();
        Ok((
            Self {
                hold,
                window: None,
                configuration: surface.configuration.clone(),
                applied_revision: surface.session.diagnostics().applied_revision,
                runtime_builtin: surface.runtime_builtin.clone(),
                monitor,
                preview_owner,
                retiring: false,
                reveal: None,
            },
            script,
        ))
    }

    pub(super) fn accept(&mut self, message: &str) -> Option<Result<()>> {
        self.hold.accept(message).map(|result| {
            result.map_err(anyhow::Error::from).and_then(|pixels| {
                self.window = Some(FrameWindow::create(
                    self.hold.request.width,
                    self.hold.request.height,
                    pixels,
                )?);
                let window = self.window.as_ref().expect("captured frame");
                if let Some(owner) = self.preview_owner {
                    window.mount_preview(&self.monitor, owner)
                } else {
                    window.mount(&self.monitor)
                }
            })
        })
    }

    pub(super) fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({"sourceGeneration":self.hold.request.generation,"captured":self.hold.received(),"sourceClosed":self.hold.source_has_closed(),
            "workspaceReleased":self.hold.workspace_released(),
            "width":self.hold.request.width,"height":self.hold.request.height,
            "targetWidth":self.monitor.width,"targetHeight":self.monitor.height,"runtimeBuiltin":self.runtime_builtin,
            "hwnd":self.window.as_ref().map(|window| window.hwnd() as usize),"visible":self.window.as_ref().is_some_and(|window| window.is_visible()),
            "presentations":self.window.as_ref().map(|window| window.presentations()),"paints":self.window.as_ref().map(|window| window.paints()),
            "bgraSha256":self.window.as_ref().map(|window| window.digest()),"revealGeneration":self.reveal.map(|(generation,_)| generation)})
    }

    pub(super) fn retire(&mut self) {
        self.retiring = true;
        self.hold.retire();
    }
    fn poll(&mut self) -> bool {
        if !self.retiring {
            return false;
        }
        if let Some(window) = self.window.as_mut() {
            if !window.close() {
                return false;
            }
            self.window = None;
        }
        self.hold.finish(true)
    }
}

impl App {
    /// Only the event-loop tick calls this: the IPC receipt handler and its large
    /// message storage have returned before any global workspace capacity shrinks.
    pub(super) fn reap_handoff_workspaces(&mut self) {
        for handoff in self
            .wallpaper_handoff
            .iter_mut()
            .chain(
                self.preview
                    .iter_mut()
                    .filter_map(|preview| preview.frame.as_mut()),
            )
            .chain(self.wallpaper_handoff_retiring.iter_mut())
        {
            let native_exited = handoff
                .window
                .as_ref()
                .is_none_or(|window| window.reap_staging());
            if let Err(error) = handoff.hold.reap_workspace(native_exited) {
                log(&format!("wallpaper workspace release pending: {error}"));
            }
        }
    }

    /// Returns true only when there is no live old renderer to overlap the new one.
    pub(super) fn prepare_wallpaper_handoff(&mut self) -> Result<bool> {
        if self
            .wallpaper_handoff_retiring
            .iter()
            .any(|handoff| handoff.window.is_some())
        {
            return Ok(false);
        }
        if self
            .wallpaper_handoff
            .as_ref()
            .is_some_and(|handoff| handoff.window.is_some())
            && self.wallpaper.is_some()
        {
            // An intent can supersede a candidate between promotion and its reveal
            // receipt. Keep the already-visible bitmap and retire that renderer too.
            if let Some(handoff) = &mut self.wallpaper_handoff {
                handoff.reveal = None;
            }
            self.retire_wallpaper_surface();
            self.wallpaper_page_ready = false;
            self.wallpaper_visible = false;
            return Ok(false);
        }
        if let Some(handoff) = &self.wallpaper_handoff {
            return Ok(handoff.window.is_some() && handoff.hold.source_has_closed());
        }
        let Some(surface) = self.wallpaper.as_ref() else {
            return Ok(true);
        };
        if !surface.first_frame_ready() {
            self.retire_wallpaper_surface();
            self.wallpaper_page_ready = false;
            self.wallpaper_visible = false;
            return Ok(false);
        }
        let (handoff, script) = Handoff::begin(surface, None)?;
        self.wallpaper_handoff = Some(handoff);
        surface.eval(&script);
        Ok(false)
    }

    fn fail_wallpaper_capture(&mut self, error: String) {
        if let Some(mut handoff) = self.wallpaper_handoff.take() {
            handoff.retire();
            self.wallpaper_handoff_retiring.push(handoff);
        }
        self.wallpaper_prepared = None;
        self.wallpaper_media_failed_revision = Some(self.config.revision);
        self.wallpaper_apply_error = Some(error);
        self.send_settings_status(self.wallpaper_apply_error.as_deref(), None);
    }

    pub(super) fn handle_wallpaper_capture(&mut self, generation: u64, message: &str) -> bool {
        if !message.starts_with(CAPTURE_PREFIX) {
            return false;
        }
        if self.handle_preview_capture(generation, message) {
            return true;
        }
        let Some(handoff) = self
            .wallpaper_handoff
            .as_mut()
            .filter(|handoff| handoff.hold.request.generation == generation)
        else {
            return true;
        };
        let Some(result) = handoff.accept(message) else {
            return true;
        };
        if let Err(error) = result {
            self.fail_wallpaper_capture(error.to_string());
            return true;
        }
        // The compositor accepted the bitmap while the old renderer is alive. Its
        // Close and file-reader barriers may run; the bitmap keeps the desktop filled.
        self.retire_wallpaper_surface();
        self.wallpaper_page_ready = false;
        self.wallpaper_visible = false;
        self.reset_wallpaper_page_stats();
        self.recompute_wallpaper();
        true
    }

    pub(super) fn handoff_source_closed(&mut self, generation: u64) {
        if let Some(handoff) = self
            .preview
            .as_mut()
            .and_then(|preview| preview.frame.as_mut())
        {
            handoff.hold.source_closed(generation);
        }
        if let Some(handoff) = &mut self.wallpaper_handoff {
            handoff.hold.source_closed(generation);
        }
        for handoff in &mut self.wallpaper_handoff_retiring {
            handoff.hold.source_closed(generation);
        }
    }

    pub(super) fn handoff_wait_for_reveal(&mut self, generation: u64) {
        if let Some(handoff) = &mut self.wallpaper_handoff {
            handoff.reveal = Some((generation, Instant::now()));
        }
    }

    pub(super) fn finish_wallpaper_handoff(&mut self, generation: u64) {
        if !self.wallpaper_handoff.as_ref().is_some_and(|handoff| {
            handoff
                .reveal
                .is_some_and(|(expected, _)| expected == generation)
        }) {
            return;
        }
        self.close_wallpaper_handoff();
    }

    pub(super) fn close_wallpaper_handoff(&mut self) {
        if let Some(mut handoff) = self.wallpaper_handoff.take() {
            handoff.retire();
            self.wallpaper_handoff_retiring.push(handoff);
        }
        self.wallpaper_handoff_retiring
            .retain_mut(|handoff| !handoff.poll());
    }

    pub(super) fn poll_wallpaper_handoff(&mut self) {
        self.wallpaper_handoff_retiring
            .retain_mut(|handoff| !handoff.poll());
        if self.wallpaper_handoff.as_ref().is_some_and(|handoff| {
            handoff
                .window
                .as_ref()
                .is_some_and(|window| !window.alive() || !native::wallpaper_alive(window.hwnd()))
        }) {
            // Explorer may destroy the child HWND. Do not keep claiming a visible
            // retained frame, or silently retry a candidate that already failed.
            self.close_wallpaper_handoff();
            if self.wallpaper.is_none()
                && self.wallpaper_candidate.is_none()
                && self.wallpaper_prepared.is_none()
            {
                self.wallpaper_media_failed_revision = Some(self.config.revision);
                self.wallpaper_apply_error = Some("静态帧窗口已失效，请重新加载壁纸".into());
            }
        }
        if self
            .wallpaper_handoff
            .as_ref()
            .is_some_and(|handoff| handoff.hold.expired())
        {
            self.fail_wallpaper_capture("旧画面未在期限内完成静态采集，保留当前桌面".into());
        }
        self.sync_wallpaper_handoff_visibility();
        if !self.wallpaper_render_allowed(&self.config.wallpaper) {
            if let Some((_, at)) = self
                .wallpaper_handoff
                .as_mut()
                .and_then(|handoff| handoff.reveal.as_mut())
            {
                // A paused renderer cannot submit its reveal frames. Resume gives
                // it a fresh bounded interval without releasing the retained bitmap.
                *at = Instant::now();
            }
            return;
        }
        if self.wallpaper_handoff.as_ref().is_some_and(|handoff| {
            handoff
                .reveal
                .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(3))
        }) {
            if let Some(handoff) = &mut self.wallpaper_handoff {
                handoff.reveal = None;
            }
            self.retire_wallpaper_surface();
            self.wallpaper_page_ready = false;
            self.wallpaper_visible = false;
            self.wallpaper_media_failed_revision = Some(self.config.revision);
            self.wallpaper_apply_error = Some("新画面未确认揭幕，继续保留静态画面".into());
            self.send_settings_status(self.wallpaper_apply_error.as_deref(), None);
        }
    }

    pub(super) fn sync_wallpaper_handoff_visibility(&self) {
        if let Some(window) = self
            .wallpaper_handoff
            .as_ref()
            .and_then(|handoff| handoff.window.as_ref())
        {
            window.visible(
                (self.config.wallpaper.enabled || self.wallpaper_forced)
                    && self.wallpaper_render_allowed(&self.config.wallpaper),
            );
        }
    }

    pub(super) fn handoff_hwnd(&self) -> Option<HWND> {
        self.wallpaper_handoff
            .as_ref()?
            .window
            .as_ref()
            .filter(|window| window.alive())
            .map(|window| window.hwnd())
    }

    pub(super) fn reconcile_wallpaper_handoff_geometry(
        &mut self,
        monitor: &native::WallpaperMonitor,
    ) {
        if self.wallpaper_handoff.as_ref().is_some_and(|handoff| {
            handoff.monitor.display_id() != monitor.display_id()
                || monitor_geometry_changed(&handoff.monitor, monitor)
        }) {
            // This bitmap's physical target is immutable and already budgeted.
            // A changed target must pass fresh admission, never enlarge this HWND.
            self.close_wallpaper_handoff();
        }
    }

    pub(super) fn handoff_diagnostics(&self) -> serde_json::Value {
        self.wallpaper_handoff
            .as_ref()
            .map_or(serde_json::Value::Null, Handoff::diagnostics)
    }
}
