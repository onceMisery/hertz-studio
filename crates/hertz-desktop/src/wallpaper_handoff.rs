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
    pub(super) runtime_reference: Option<crate::wallpaper::playlist::FixedVersion>,
    monitor: native::WallpaperMonitor,
    preview_owner: Option<HWND>,
    retiring: bool,
    pub(super) reveal: Option<(u64, Instant)>,
    pub(super) pause_retained: bool,
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
                runtime_reference: surface.runtime_reference.clone(),
                monitor,
                preview_owner,
                retiring: false,
                reveal: None,
                pause_retained: false,
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
            "bgraSha256":self.window.as_ref().map(|window| window.digest()),"revealGeneration":self.reveal.map(|(generation,_)| generation),"pauseRetained":self.pause_retained})
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
            .desktop
            .runtimes
            .values_mut()
            .filter_map(|desktop| desktop.handoff.as_mut())
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
        // Capture workspaces are temporary peaks. Serialize their actual exit,
        // while independent retained bitmaps continue to hold their full bytes.
        // This lets four mirrors switch without four simultaneous 64 MiB tasks.
        if self.desktop.handoff.is_none()
            && (self
                .desktop
                .runtimes
                .values()
                .filter_map(|runtime| runtime.handoff.as_ref())
                .chain(self.wallpaper_handoff_retiring.iter())
                .any(|handoff| !handoff.hold.workspace_released())
                || self
                    .preview
                    .as_ref()
                    .and_then(|preview| preview.frame.as_ref())
                    .is_some_and(|handoff| !handoff.hold.workspace_released()))
        {
            return Ok(false);
        }
        if self
            .wallpaper_handoff_retiring
            .iter()
            .any(|handoff| handoff.window.is_some())
        {
            return Ok(false);
        }
        if self
            .desktop
            .handoff
            .as_ref()
            .is_some_and(|handoff| handoff.window.is_some())
            && self.desktop.surface.is_some()
        {
            // An intent can supersede a candidate between promotion and its reveal
            // receipt. Keep the already-visible bitmap and retire that renderer too.
            if let Some(handoff) = &mut self.desktop.handoff {
                handoff.reveal = None;
            }
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            return Ok(false);
        }
        if let Some(handoff) = &self.desktop.handoff {
            return Ok(handoff.window.is_some() && handoff.hold.source_has_closed());
        }
        let Some(surface) = self.desktop.surface.as_ref() else {
            return Ok(true);
        };
        if !surface.first_frame_ready() {
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            return Ok(false);
        }
        let (handoff, script) = Handoff::begin(surface, None)?;
        surface.eval(&script);
        self.desktop.handoff = Some(handoff);
        Ok(false)
    }

    fn fail_wallpaper_capture(&mut self, error: String) {
        let pause_retained = self
            .desktop
            .handoff
            .as_ref()
            .is_some_and(|handoff| handoff.pause_retained);
        if let Some(mut handoff) = self.desktop.handoff.take() {
            handoff.retire();
            self.wallpaper_handoff_retiring.push(handoff);
        }
        if !pause_retained {
            self.desktop.prepared = None;
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
        } else {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.desktop.policy_released = true;
        }
        self.desktop.apply_error = Some(error);
        self.send_settings_status(self.desktop.apply_error.as_deref(), None);
    }

    pub(super) fn handle_wallpaper_capture(&mut self, generation: u64, message: &str) -> bool {
        if !message.starts_with(CAPTURE_PREFIX) {
            return false;
        }
        let Some(handoff) = self
            .desktop
            .handoff
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
        if handoff.pause_retained {
            self.desktop.policy_released = true;
        }
        // The compositor accepted the bitmap while the old renderer is alive. Its
        // Close and file-reader barriers may run; the bitmap keeps the desktop filled.
        self.retire_wallpaper_surface();
        self.desktop.page_ready = false;
        self.desktop.visible = false;
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
        for handoff in self
            .desktop
            .runtimes
            .values_mut()
            .filter_map(|desktop| desktop.handoff.as_mut())
        {
            handoff.hold.source_closed(generation);
        }
        for handoff in &mut self.wallpaper_handoff_retiring {
            handoff.hold.source_closed(generation);
        }
    }

    pub(super) fn handoff_wait_for_reveal(&mut self, generation: u64) {
        if let Some(handoff) = &mut self.desktop.handoff {
            handoff.reveal = Some((generation, Instant::now()));
        }
    }

    pub(super) fn finish_wallpaper_handoff(&mut self, generation: u64) {
        if !self.desktop.handoff.as_ref().is_some_and(|handoff| {
            handoff
                .reveal
                .is_some_and(|(expected, _)| expected == generation)
        }) {
            return;
        }
        self.close_wallpaper_handoff();
        self.playlist_presented(generation);
    }

    pub(super) fn close_wallpaper_handoff(&mut self) {
        if let Some(mut handoff) = self.desktop.handoff.take() {
            handoff.retire();
            self.wallpaper_handoff_retiring.push(handoff);
        }
        self.wallpaper_handoff_retiring
            .retain_mut(|handoff| !handoff.poll());
    }

    pub(super) fn poll_wallpaper_handoff(&mut self) {
        if self.desktop.handoff.as_ref().is_some_and(|handoff| {
            handoff
                .window
                .as_ref()
                .is_some_and(|window| !window.alive() || !native::wallpaper_alive(window.hwnd()))
        }) {
            // Explorer may destroy the child HWND. Do not keep claiming a visible
            // retained frame, or silently retry a candidate that already failed.
            self.close_wallpaper_handoff();
            if self.desktop.surface.is_none()
                && self.desktop.candidate.is_none()
                && self.desktop.prepared.is_none()
            {
                self.desktop.failed_revision = Some(self.desktop.desired_revision);
                self.desktop.apply_error = Some("静态帧窗口已失效，请重新加载壁纸".into());
            }
        }
        if self
            .desktop
            .handoff
            .as_ref()
            .is_some_and(|handoff| handoff.hold.expired())
        {
            self.fail_wallpaper_capture("旧画面未在期限内完成静态采集，保留当前桌面".into());
        }
        self.sync_wallpaper_handoff_visibility();
        if !self.wallpaper_render_allowed() {
            if let Some((_, at)) = self
                .desktop
                .handoff
                .as_mut()
                .and_then(|handoff| handoff.reveal.as_mut())
            {
                // A paused renderer cannot submit its reveal frames. Resume gives
                // it a fresh bounded interval without releasing the retained bitmap.
                *at = Instant::now();
            }
            return;
        }
        if self.desktop.handoff.as_ref().is_some_and(|handoff| {
            handoff
                .reveal
                .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(3))
        }) {
            if let Some(handoff) = &mut self.desktop.handoff {
                handoff.reveal = None;
            }
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
            self.desktop.apply_error = Some("新画面未确认揭幕，继续保留静态画面".into());
            self.send_settings_status(self.desktop.apply_error.as_deref(), None);
        }
    }

    pub(super) fn poll_handoff_retirements(&mut self) {
        self.wallpaper_handoff_retiring
            .retain_mut(|handoff| !handoff.poll());
    }

    pub(super) fn sync_wallpaper_handoff_visibility(&self) {
        if let Some(window) = self
            .desktop
            .handoff
            .as_ref()
            .and_then(|handoff| handoff.window.as_ref())
        {
            window.visible(
                self.wallpaper_target_running(&self.desktop.configuration)
                    && !self
                        .desktop
                        .recovery
                        .is_terminal(crate::wallpaper::session::FaultDomain::Global)
                    && policy::retain_frame(&policy::PolicyInputs {
                        enabled: true,
                        wallpaper: &self.desktop.configuration,
                        manual_pause: self.wallpaper_hidden,
                        fullscreen: self.desktop.fullscreen_gate.stable(),
                        maximized: self.desktop.maximized_gate.stable(),
                        application_rule: self.desktop.application_gate.stable(),
                        session_unavailable: self.policy.session_unavailable,
                        display_off: self.policy.display_off,
                        display_missing: self.desktop.monitor_missing,
                        power: self.wallpaper_power,
                        has_surface: true,
                        page_ready: true,
                    }),
            );
        }
    }

    pub(super) fn reconcile_wallpaper_handoff_geometry(
        &mut self,
        monitor: &native::WallpaperMonitor,
    ) {
        if self.desktop.handoff.as_ref().is_some_and(|handoff| {
            handoff.monitor.display_id() != monitor.display_id()
                || monitor_geometry_changed(&handoff.monitor, monitor)
        }) {
            // This bitmap's physical target is immutable and already budgeted.
            // A changed target must pass fresh admission, never enlarge this HWND.
            self.close_wallpaper_handoff();
        }
    }
}
