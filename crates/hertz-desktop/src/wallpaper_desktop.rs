// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native single-media selection and controller handoff. Expensive work stays in LibraryService.
use super::*;
use crate::wallpaper::{
    config::Selection,
    image_prepare::{ImageFit, ImagePurpose, ImageTarget},
    jobs::JobError,
    page_events::PageEvent,
    target_planner::ResolvedMedia,
};

type JobResult<T> = std::result::Result<T, JobError>;

/// One runtime checkpoint, with no file handles, decoder or budget token. It is
/// used only after requalification resolves the same revision and media bytes,
/// and consumed after the resumed candidate really presents its first frame.
pub(super) struct PlaybackResume {
    revision: u64,
    binding: crate::wallpaper::page_events::PageBinding,
    reference: crate::wallpaper::target_planner::AssetRef,
    content_key: String,
    duration_ms: u64,
    position_ms: u64,
}
impl PlaybackResume {
    pub(super) fn generation(&self) -> u64 {
        self.binding.generation()
    }

    fn position_for(
        &self,
        revision: u64,
        reference: &crate::wallpaper::target_planner::AssetRef,
        content_key: &str,
        metadata: &crate::wallpaper::media::MediaProbe,
    ) -> Option<u64> {
        (self.revision == revision
            && self.reference.package_hash == reference.package_hash
            && self.reference.asset_id == reference.asset_id
            && self.reference.variant_id == reference.variant_id
            && self.content_key == content_key
            && metadata.container != crate::wallpaper::media::Container::Image
            && metadata.duration_ms == Some(self.duration_ms)
            && self.position_ms < self.duration_ms)
            .then_some(self.position_ms)
    }

    pub(super) fn observe(&mut self, revision: u64, generation: u64, event: &str) -> bool {
        if self.revision != revision || self.binding.generation() != generation {
            return false;
        }
        if let Some(PageEvent::MediaPosition(position)) = self.binding.parse(event) {
            if position < self.duration_ms {
                self.position_ms = position;
            }
            return true;
        }
        false
    }

    pub(super) fn position_at(&self, revision: u64) -> Option<u64> {
        (self.revision == revision).then_some(self.position_ms)
    }
}

pub(super) struct SelectionTask {
    pub(super) id: u64,
    pub(super) cancel: Arc<AtomicBool>,
    configuration: config::WallpaperConfig,
    revision: u64,
    monitor: native::WallpaperMonitor,
    playlist_switch: Option<crate::wallpaper::playlist::Switch>,
    reference: Option<crate::wallpaper::playlist::FixedVersion>,
    playlist_epoch: u64,
    mirror_generation: Option<u64>,
}
impl SelectionTask {
    /// 删除保护：准备中的固定版本仍可能被本次任务读取。
    pub(super) fn references_package(
        &self,
        work_key: Option<&str>,
        package_hash: Option<&str>,
    ) -> bool {
        self.configuration
            .references_package(work_key, package_hash)
            || self
                .reference
                .as_ref()
                .is_some_and(|v| v.matches(work_key, package_hash))
            || (self.reference.is_none()
                && matches!(
                    self.configuration.main().selection,
                    Selection::Playlist { .. }
                ))
    }
    pub(super) fn selects_playlist(&self, id: &str) -> bool {
        matches!(&self.configuration.main().selection, Selection::Playlist { playlist_id } if playlist_id == id)
    }
}

pub(super) struct Prepared {
    media: Option<ResolvedMedia>,
    builtin: Option<crate::wallpaper::config::BuiltinState>,
    reference: Option<crate::wallpaper::playlist::FixedVersion>,
    playlist_token: Option<u64>,
    static_poster: bool,
    configuration: config::WallpaperConfig,
    revision: u64,
    monitor: native::WallpaperMonitor,
}
impl Prepared {
    pub(super) fn references_package(
        &self,
        work_key: Option<&str>,
        package_hash: Option<&str>,
    ) -> bool {
        self.configuration
            .references_package(work_key, package_hash)
            || self
                .reference
                .as_ref()
                .is_some_and(|v| v.matches(work_key, package_hash))
    }
}

/// Window policy changes take effect on the current renderer. They must not
/// restart a video, replace a playlist runner, or invalidate an in-flight frame.
pub(super) fn same_render_intent(a: &config::WallpaperConfig, b: &config::WallpaperConfig) -> bool {
    a.enabled == b.enabled
        && a.audio_input == b.audio_input
        && serde_json::to_value(&a.groups).expect("wallpaper groups")
            == serde_json::to_value(&b.groups).expect("wallpaper groups")
}

pub(super) fn target(
    configuration: &config::WallpaperConfig,
    monitor: &native::WallpaperMonitor,
) -> ImageTarget {
    use crate::config::WallpaperQuality;
    use crate::wallpaper::config::Fit;
    ImageTarget {
        // Direct video fills the actual physical target. CSS or a quality label cannot lower its cost.
        width: monitor.width.max(1) as u32,
        height: monitor.height.max(1) as u32,
        fit: match configuration.presentation().fit {
            Fit::Contain => ImageFit::Contain,
            _ => ImageFit::Cover,
        },
        purpose: match configuration.presentation().quality {
            WallpaperQuality::Low => ImagePurpose::Low,
            WallpaperQuality::Medium => ImagePurpose::Medium,
            WallpaperQuality::High => ImagePurpose::High,
        },
    }
}

impl App {
    pub(super) fn tick_wallpaper_follow(&mut self, target: &EventLoopWindowTarget<()>) {
        if !self.desktop.configuration.follows_hertz()
            || !self.wallpaper_target_running(&self.desktop.configuration)
            || self.desktop.failed_revision == Some(self.desktop.desired_revision)
            || self.desktop.recovery_terminal
            || !self.wallpaper_render_allowed()
        {
            return;
        }
        let desired = crate::wallpaper::follow::resolve(
            &self.desktop.configuration,
            self.wallpaper_last.as_ref(),
        );
        let pending_changed = self
            .desktop
            .candidate
            .as_ref()
            .is_some_and(|surface| surface.runtime_builtin != desired);
        if pending_changed {
            self.cancel_wallpaper_transition();
        }
        if self.desktop.candidate.is_some() || self.desktop.prepared.is_some() {
            return;
        }
        if pending_changed
            || self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.runtime_builtin != desired)
        {
            if let Err(error) = self.stage_builtin_wallpaper(target) {
                self.desktop.apply_error = Some(error.to_string());
            }
        }
    }

    fn begin_wallpaper_selection(
        &mut self,
        configuration: config::WallpaperConfig,
        slot: crate::wallpaper::service::Slot,
    ) -> JobResult<()> {
        self.begin_selection_switch(configuration, slot, None)
    }

    pub(super) fn install_resolved_plan(
        &mut self,
        plan: crate::wallpaper::selection_plan::ResolvedPlan,
        monitor: native::WallpaperMonitor,
    ) {
        if let Err(error) = wallpaper_mirror::validate_plan(&self.desktop.configuration, &plan) {
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
            self.desktop.apply_error = Some(error.to_string());
            self.fail_mirror_target();
            return;
        }
        let crate::wallpaper::selection_plan::ResolvedPlan {
            content,
            reference,
            playlist,
        } = plan;
        let (media, builtin) = match content {
            crate::wallpaper::selection_plan::ResolvedSelection::Builtin(state) => {
                (None, Some(state))
            }
            crate::wallpaper::selection_plan::ResolvedSelection::Media(media) => {
                (Some(media), None)
            }
        };
        let playlist_token = if self.is_mirror_target() {
            if let Some(playlist) = playlist {
                self.install_mirror_playlist(playlist);
            }
            self.mirror_switch().map(|switch| switch.token)
        } else {
            self.install_playlist_snapshot(playlist)
        };
        self.cancel_wallpaper_transition();
        self.desktop.prepared = Some(Prepared {
            media,
            builtin,
            reference: Some(reference),
            playlist_token,
            static_poster: false,
            configuration: self.desktop.configuration.clone(),
            revision: self.desktop.desired_revision,
            monitor,
        });
        self.desktop.failed_revision = None;
    }

    pub(super) fn begin_selection_switch(
        &mut self,
        configuration: config::WallpaperConfig,
        slot: crate::wallpaper::service::Slot,
        playlist_switch: Option<crate::wallpaper::playlist::Switch>,
    ) -> JobResult<()> {
        if self.wallpaper_apply.is_some()
            || self
                .desktop
                .runtimes
                .values()
                .any(|runtime| runtime.selection.is_some())
        {
            return Err(JobError::new(
                "budget_busy",
                "已有作品正在准备，请等待完成或取消原草稿",
            ));
        }
        validate_configured_presentation(&configuration).map_err(JobError::invalid_input)?;
        let playlist_switch = playlist_switch.or_else(|| self.is_mirror_target().then(|| self.mirror_switch()).flatten()).or_else(|| {
            self.desktop.playlist.as_ref().filter(|runner| matches!(&configuration.main().selection, Selection::Playlist { playlist_id } if playlist_id == &runner.playlist().playlist_id)).and_then(|runner| runner.pending()).cloned()
        });
        let mut selection = configuration.main().selection.clone();
        if let Some(switch) = &playlist_switch {
            selection = switch.reference.selection();
        } else {
            if let Selection::Playlist { playlist_id } = &selection {
                if let Some(current) = self
                    .desktop
                    .playlist
                    .as_ref()
                    .filter(|runner| &runner.playlist().playlist_id == playlist_id)
                    .and_then(|runner| runner.current())
                {
                    selection = current.selection();
                }
            }
        }
        let reference = match &selection {
            Selection::Package {
                work_key,
                package_hash,
            } => Some(crate::wallpaper::playlist::FixedVersion {
                work_key: work_key.clone(),
                package_hash: package_hash.clone(),
            }),
            _ => None,
        };
        let monitor = self
            .desktop_monitor()
            .ok_or_else(|| JobError::new("display_missing", "目标显示器未连接，未改写选择"))?;
        self.wallpaper_generation += 1;
        let id = self.wallpaper_generation;
        let cancel = Arc::new(AtomicBool::new(false));
        let proxy = self.proxy.clone();
        self.wallpaper_library.resolve_desktop_selection(
            selection,
            target(&configuration, &monitor),
            crate::wallpaper::selection_plan::SelectionOptions {
                mirror_members: (configuration.main().mode
                    == crate::wallpaper::config::LayoutMode::Mirror)
                    .then_some(configuration.main().displays.len()),
                resume: None,
                properties: configuration.main().properties.clone(),
            },
            Arc::clone(&cancel),
            slot,
            move |result| {
                let _ = proxy.send_event(UserEvent::WallpaperSelection(id, result.map(Box::new)));
            },
        )?;
        self.desktop.selection = Some(SelectionTask {
            id,
            cancel,
            configuration,
            revision: self.desktop.desired_revision,
            monitor,
            playlist_switch,
            reference,
            playlist_epoch: self.desktop.playlist_epoch,
            mirror_generation: self
                .desktop
                .mirror_ticket
                .as_ref()
                .map(|ticket| ticket.generation),
        });
        Ok(())
    }

    pub(super) fn finish_wallpaper_selection(
        &mut self,
        id: u64,
        result: std::result::Result<
            crate::wallpaper::selection_plan::ResolvedPlan,
            crate::wallpaper::selection_plan::Failure,
        >,
        target: &EventLoopWindowTarget<()>,
    ) {
        if self.apply_owns_selection(id) {
            self.finish_apply_selection(id, result, target);
            return;
        }
        if let Some(key) = self.desktop.route_selection(id) {
            self.with_desktop(&key, |app| app.finish_desktop_selection(id, result, target));
        }
    }

    fn finish_desktop_selection(
        &mut self,
        id: u64,
        result: std::result::Result<
            crate::wallpaper::selection_plan::ResolvedPlan,
            crate::wallpaper::selection_plan::Failure,
        >,
        loop_target: &EventLoopWindowTarget<()>,
    ) {
        if !self
            .desktop
            .selection
            .as_ref()
            .is_some_and(|task| task.id == id)
        {
            return;
        }
        let task = self.desktop.selection.take().expect("selection task");
        if self.desktop.closing {
            return;
        }
        let result = if task.cancel.load(Ordering::Acquire)
            || task.playlist_epoch != self.desktop.playlist_epoch
            || (self.is_mirror_target()
                && task.mirror_generation
                    != self
                        .desktop
                        .mirror_ticket
                        .as_ref()
                        .map(|ticket| ticket.generation))
        {
            Err(JobError::new("cancelled", "作品准备已取消并退出").into())
        } else {
            result
        };
        let media = match result {
            Ok(media) => media,
            Err(failure) => {
                let error = failure.error;
                if error.code != "cancelled"
                    && error.code != "budget_busy"
                    && task.revision == self.desktop.desired_revision
                    && same_render_intent(&task.configuration, &self.desktop.configuration)
                {
                    self.desktop.playback = None;
                    self.desktop.failed_revision = Some(task.revision);
                    self.desktop.apply_error = Some(error.to_string());
                    if self.desktop.surface.is_none() {
                        if let Some(poster) = failure.poster {
                            self.desktop.prepared = Some(Prepared {
                                media: Some(*poster),
                                builtin: None,
                                reference: task.reference,
                                playlist_token: None,
                                static_poster: true,
                                configuration: task.configuration,
                                revision: task.revision,
                                monitor: task.monitor,
                            });
                            if let Err(error) = self.try_stage_wallpaper(loop_target) {
                                log(&format!("startup poster could not be staged: {error}"));
                            }
                        }
                    }
                    self.send_settings_status(self.desktop.apply_error.as_deref(), None);
                }
                return;
            }
        };
        if let Err(error) = wallpaper_mirror::validate_plan(&task.configuration, &media) {
            self.desktop.failed_revision = Some(task.revision);
            self.desktop.apply_error = Some(error.to_string());
            self.fail_mirror_target();
            return;
        }
        let crate::wallpaper::selection_plan::ResolvedPlan {
            content,
            reference,
            playlist,
        } = media;
        let (media, builtin) = match content {
            crate::wallpaper::selection_plan::ResolvedSelection::Builtin(state) => {
                (None, Some(state))
            }
            crate::wallpaper::selection_plan::ResolvedSelection::Media(media) => {
                (Some(media), None)
            }
        };
        let playlist_token = task.playlist_switch.as_ref().map(|switch| switch.token);
        if !self.is_mirror_target()
            && task.playlist_switch.as_ref().is_some_and(|switch| {
                self.desktop
                    .playlist
                    .as_ref()
                    .and_then(|r| r.pending())
                    .is_none_or(|pending| {
                        pending.token != switch.token || pending.reference != reference
                    })
            })
        {
            return;
        }
        if task.revision == self.desktop.desired_revision
            && same_render_intent(&task.configuration, &self.desktop.configuration)
        {
            let playlist_token = if self.is_mirror_target() {
                if let Some(playlist) = playlist {
                    self.install_mirror_playlist(playlist);
                }
                self.mirror_switch().map(|switch| switch.token)
            } else {
                self.install_playlist_snapshot(playlist).or(playlist_token)
            };
            self.desktop.prepared = Some(Prepared {
                media,
                builtin,
                reference: Some(reference),
                playlist_token,
                static_poster: false,
                configuration: task.configuration,
                revision: task.revision,
                monitor: task.monitor,
            });
            if let Err(error) = self.try_stage_wallpaper(loop_target) {
                self.desktop.apply_error = Some(error.to_string());
            }
        }
    }

    pub(super) fn ensure_media_wallpaper(
        &mut self,
        loop_target: &EventLoopWindowTarget<()>,
    ) -> Result<()> {
        validate_configured_presentation(&self.desktop.configuration)
            .map_err(anyhow::Error::msg)?;
        if self.desktop.surface.as_ref().is_some_and(|surface| {
            same_render_intent(&surface.configuration, &self.desktop.configuration)
                && (!self.is_mirror_target() || self.mirror_surface_matches(surface))
                && (!surface.static_poster
                    || self.desktop.failed_revision == Some(self.desktop.desired_revision))
                && native::wallpaper_alive(surface.hwnd())
        }) {
            return Ok(());
        }
        if self.desktop.candidate.is_some() || self.desktop.selection.is_some() {
            return Ok(());
        }
        if self.desktop.prepared.is_some() {
            return self.try_stage_wallpaper(loop_target);
        }
        if self.desktop.failed_revision == Some(self.desktop.desired_revision) {
            bail!("当前作品未能呈现，请明确重试或重新选择");
        }
        if !self.wallpaper_render_allowed() {
            return Ok(());
        }
        if self.is_mirror_target()
            && self
                .desktop
                .mirrors
                .get(&self.desktop.configuration.main().id)
                .is_some_and(|group| group.playback.is_failed())
        {
            return Ok(());
        }
        if self.wallpaper_apply.is_some()
            || self
                .desktop
                .runtimes
                .values()
                .any(|runtime| runtime.selection.is_some())
        {
            return Ok(());
        }
        if self.is_mirror_target() && self.mirror_sources_releasing() {
            return Ok(());
        }
        let slot = self
            .wallpaper_library
            .reserve()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.begin_wallpaper_selection(self.desktop.configuration.clone(), slot)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }

    pub(super) fn wallpaper_render_allowed(&self) -> bool {
        if self
            .desktop
            .recovery
            .is_terminal(crate::wallpaper::session::FaultDomain::Global)
        {
            return false;
        }
        policy::renderable(&policy::PolicyInputs {
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
        })
    }

    pub(super) fn stage_builtin_wallpaper(
        &mut self,
        loop_target: &EventLoopWindowTarget<()>,
    ) -> Result<()> {
        let configuration = self.desktop.configuration.clone();
        let monitor = self
            .desktop_monitor()
            .ok_or_else(|| anyhow::anyhow!("目标显示器未连接"))?;
        self.desktop.prepared = Some(Prepared {
            media: None,
            builtin: None,
            reference: None,
            playlist_token: None,
            static_poster: false,
            configuration,
            revision: self.desktop.desired_revision,
            monitor,
        });
        self.try_stage_wallpaper(loop_target)
    }

    fn try_stage_wallpaper(&mut self, loop_target: &EventLoopWindowTarget<()>) -> Result<()> {
        let Some(prepared) = self.desktop.prepared.as_ref() else {
            return Ok(());
        };
        if prepared.revision != self.desktop.desired_revision
            || !same_render_intent(&prepared.configuration, &self.desktop.configuration)
        {
            self.desktop.prepared = None;
            return Ok(());
        }
        if !self.wallpaper_render_allowed() || self.desktop.candidate.is_some() {
            return Ok(());
        }
        // Preparation can wait through a policy pause. Its fixed target must still match
        // the real display immediately before admission; otherwise resolve a fresh plan.
        let Some(monitor) = self.desktop_monitor() else {
            return Ok(());
        };
        if monitor.display_id() != prepared.monitor.display_id()
            || monitor_geometry_changed(&monitor, &prepared.monitor)
        {
            let mut prepared = self.desktop.prepared.take().expect("prepared selection");
            if prepared.media.is_some() && !prepared.static_poster {
                let slot = self
                    .wallpaper_library
                    .reserve()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let switch = self
                    .is_mirror_target()
                    .then(|| self.mirror_switch())
                    .flatten()
                    .or_else(|| {
                        prepared.playlist_token.and_then(|token| {
                            self.desktop
                                .playlist
                                .as_ref()
                                .and_then(|runner| runner.pending())
                                .filter(|switch| switch.token == token)
                                .cloned()
                        })
                    });
                return self
                    .begin_selection_switch(prepared.configuration, slot, switch)
                    .map_err(|error| anyhow::anyhow!(error.to_string()));
            }
            if prepared.static_poster {
                if let Some(media) = prepared.media.take() {
                    prepared.media = Some(
                        media.retarget_static_image(target(&prepared.configuration, &monitor))?,
                    );
                }
            }
            self.desktop.prepared = Some(Prepared {
                monitor,
                ..prepared
            });
        }
        self.poll_wallpaper_retirements();
        if !self.wallpaper_retiring.is_empty() {
            return Ok(());
        }
        match self.prepare_wallpaper_handoff() {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(error) => {
                self.desktop.prepared = None;
                self.desktop.failed_revision = Some(self.desktop.desired_revision);
                return Err(error);
            }
        }
        let prepared = self.desktop.prepared.take().expect("prepared selection");
        self.wallpaper_generation += 1;
        let generation = self.wallpaper_generation;
        let mut surface = match create_resolved_presentation(
            loop_target,
            self.proxy.clone(),
            generation,
            prepared.revision,
            prepared.configuration,
            prepared.builtin,
            prepared.monitor,
            PresentationWindow::Desktop { candidate: true },
        ) {
            Ok(surface) => surface,
            Err(error) => {
                self.desktop.failed_revision = Some(self.desktop.desired_revision);
                return Err(error);
            }
        };
        surface.static_poster = prepared.static_poster;
        surface.runtime_reference = prepared.reference;
        surface.playlist_token = prepared.playlist_token;
        surface.mirror_source_generation = self
            .desktop
            .mirrors
            .get(&self.desktop.configuration.main().id)
            .map(|group| group.source_generation);
        if surface.runtime_builtin.is_none() || surface.configuration.follows_hertz() {
            surface.runtime_builtin = crate::wallpaper::follow::resolve(
                &surface.configuration,
                self.wallpaper_last.as_ref(),
            );
        }
        if let Some(media) = prepared.media {
            let resume = self.desktop.playback.as_ref().and_then(|resume| {
                resume.position_for(
                    prepared.revision,
                    media.reference(),
                    media.content_key(),
                    &media.input().metadata,
                )
            });
            if resume.is_none() {
                self.desktop.playback = None;
            }
            let owner = format!("desktop-{}", generation);
            if let Err(error) = surface.session.admit_media(
                generation,
                media,
                crate::wallpaper::budget::global(),
                &surface._media_access,
                owner,
            ) {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
                self.desktop.failed_revision = Some(self.desktop.desired_revision);
                return Err(anyhow::anyhow!(error.to_string()));
            }
            if let Some(position) = resume {
                surface.session.record_media_position(generation, position);
            }
        }
        self.desktop.candidate_ticket = self
            .desktop
            .topology
            .current()
            .ticket(self.desktop.current.as_deref().expect("target dispatch"));
        self.desktop.candidate = Some(surface);
        Ok(())
    }

    fn retire_wallpaper_candidate(&mut self) {
        if let Some(surface) = self.desktop.candidate.take() {
            if self.is_mirror_target() {
                self.desktop.mirror_rebuild = true;
            }
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
    }

    pub(super) fn cancel_wallpaper_transition(&mut self) {
        if let Some(task) = &self.desktop.selection {
            task.cancel.store(true, Ordering::Release);
        }
        self.desktop.prepared = None;
        if let Some(surface) = self.desktop.candidate.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
    }

    /// Keep verified poster fallback separate from the failed group switch.
    pub(super) fn cancel_mirror_failure_transition(&mut self) {
        if let Some(task) = &self.desktop.selection {
            task.cancel.store(true, Ordering::Release);
        }
        if self
            .desktop
            .prepared
            .as_ref()
            .is_some_and(|prepared| !prepared.static_poster)
        {
            self.desktop.prepared = None;
        }
        if self
            .desktop
            .candidate
            .as_ref()
            .is_some_and(|surface| !surface.static_poster)
        {
            if let Some(surface) = self.desktop.candidate.take() {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
            }
        }
    }

    fn fail_wallpaper_candidate(&mut self, message: String) {
        self.fail_mirror_target();
        self.desktop.playback = None;
        if let Some(surface) = self.desktop.candidate.take() {
            if self.desktop.surface.is_none() && self.desktop.handoff.is_none() {
                self.desktop.prepared = self.poster_for_surface(&surface);
            }
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        self.desktop.failed_revision = Some(self.desktop.desired_revision);
        self.desktop.apply_error = Some(message);
        self.send_settings_status(self.desktop.apply_error.as_deref(), None);
    }

    fn poster_for_surface(&self, surface: &WallpaperSurface) -> Option<Prepared> {
        if surface.static_poster
            || !same_render_intent(&surface.configuration, &self.desktop.configuration)
        {
            return None;
        }
        Some(Prepared {
            media: Some(surface.session.media()?.poster()?.clone()),
            builtin: None,
            reference: surface.runtime_reference.clone(),
            playlist_token: None,
            static_poster: true,
            configuration: surface.configuration.clone(),
            revision: self.desktop.desired_revision,
            monitor: surface.monitor.clone(),
        })
    }

    pub(super) fn prepare_failed_wallpaper_poster(&mut self) {
        self.desktop.playback = None;
        if self.desktop.prepared.is_none() && self.desktop.candidate.is_none() {
            self.desktop.prepared = self
                .desktop
                .surface
                .as_ref()
                .and_then(|surface| self.poster_for_surface(surface));
        }
    }

    pub(super) fn retain_static_wallpaper_poster(&mut self) {
        if let Some(surface) = self
            .desktop
            .surface
            .as_ref()
            .filter(|surface| surface.static_poster)
            .or_else(|| {
                self.desktop
                    .candidate
                    .as_ref()
                    .filter(|surface| surface.static_poster)
            })
        {
            if self.desktop.prepared.is_none()
                && same_render_intent(&surface.configuration, &self.desktop.configuration)
            {
                self.desktop.prepared = Some(Prepared {
                    media: surface.session.media().cloned(),
                    builtin: None,
                    reference: surface.runtime_reference.clone(),
                    playlist_token: None,
                    static_poster: true,
                    configuration: surface.configuration.clone(),
                    revision: self.desktop.desired_revision,
                    monitor: surface.monitor.clone(),
                });
            }
        }
    }

    pub(super) fn retain_wallpaper_playback(&mut self) {
        let Some(surface) = self.desktop.surface.as_ref().filter(|surface| {
            !surface.static_poster
                && surface.first_frame_ready()
                && same_render_intent(&surface.configuration, &self.desktop.configuration)
                && surface.session.diagnostics().desired_revision
                    == Some(self.desktop.desired_revision)
        }) else {
            return;
        };
        let Some(media) = surface.session.media() else {
            return;
        };
        let Some(position_ms) = surface.session.media_position_ms() else {
            return;
        };
        let Some(duration_ms) = media.input().metadata.duration_ms else {
            return;
        };
        self.desktop.playback = Some(PlaybackResume {
            revision: self.desktop.desired_revision,
            binding: surface.binding.clone(),
            reference: media.reference().clone(),
            content_key: media.content_key().into(),
            duration_ms,
            position_ms,
        });
    }

    pub(super) fn retry_media_wallpaper(&mut self, target: &EventLoopWindowTarget<()>) {
        if self.desktop.playlist.is_none()
            && matches!(
                self.desktop.configuration.main().selection,
                Selection::Playlist { .. }
            )
        {
            self.desktop.playlist_reload_needed = true;
            self.tick_wallpaper_playlist();
            return;
        }
        if let Some(id) = self
            .desktop
            .playlist
            .as_ref()
            .filter(|r| r.is_failed())
            .map(|r| r.playlist().playlist_id.clone())
        {
            let group_id = self.desktop.configuration.main().id.clone();
            if let Err(error) = self.playlist_next(&id, Some(&group_id), true) {
                self.desktop.apply_error = Some(error.to_string());
            }
            return;
        }
        if self
            .desktop
            .prepared
            .as_ref()
            .is_some_and(|prepared| prepared.static_poster)
        {
            self.desktop.prepared = None;
        }
        if let Err(error) = self.ensure_media_wallpaper(target) {
            self.desktop.apply_error = Some(error.to_string());
        }
    }

    pub(super) fn promote_wallpaper_candidate(&mut self) {
        let Some(surface) = self.desktop.candidate.as_ref() else {
            return;
        };
        let target_valid = self
            .desktop
            .candidate_ticket
            .as_ref()
            .is_some_and(|ticket| self.desktop.topology.accepts(ticket))
            && self.desktop_monitor().is_some_and(|monitor| {
                monitor.display_id() == surface.monitor.display_id()
                    && !monitor_geometry_changed(&monitor, &surface.monitor)
            });
        if !target_valid {
            self.retire_wallpaper_candidate();
            self.desktop.candidate_ticket = None;
            if self.desktop.configuration.builtin().is_some() {
                if let Some(descriptor) = &self.desktop.target {
                    self.desktop.prepared = Some(Prepared {
                        media: None,
                        builtin: None,
                        reference: None,
                        playlist_token: None,
                        static_poster: false,
                        configuration: self.desktop.configuration.clone(),
                        revision: self.desktop.desired_revision,
                        monitor: descriptor.monitor(),
                    });
                }
            }
            return;
        }
        if !surface.first_frame_ready() || !self.wallpaper_render_allowed() {
            return;
        }
        if !self.mirror_candidate_ready() {
            return;
        }
        let surface = self.desktop.candidate.as_ref().expect("ready candidate");
        if let Err(error) = native::wallpaper_opacity(surface.hwnd(), 255) {
            self.fail_wallpaper_candidate(error.to_string());
            return;
        }
        let surface = self.desktop.candidate.take().expect("ready candidate");
        self.desktop.candidate_ticket = None;
        self.desktop.playback = None;
        self.retire_wallpaper_surface();
        self.desktop.surface = Some(surface);
        self.desktop.mirror_presented = None;
        self.desktop.mirror_sync_at = None;
        self.handoff_wait_for_reveal(
            self.desktop
                .surface
                .as_ref()
                .expect("promoted candidate")
                .binding
                .generation(),
        );
        if self.desktop.handoff.is_none() && !self.is_mirror_target() {
            let generation = self
                .desktop
                .surface
                .as_ref()
                .expect("promoted")
                .binding
                .generation();
            self.playlist_presented(generation);
        }
        self.desktop.page_ready = true;
        self.desktop.monitor_missing = false;
        if !self
            .desktop
            .surface
            .as_ref()
            .is_some_and(|surface| surface.static_poster)
        {
            self.desktop.apply_error = None;
        }
        self.reset_wallpaper_page_stats();
        self.desktop.heartbeat_at = Some(Instant::now());
        self.recompute_wallpaper();
        self.send_settings_status(None, None);
    }

    pub(super) fn handle_candidate_page(&mut self, generation: u64, event: &str) -> bool {
        if !self
            .desktop
            .candidate
            .as_ref()
            .is_some_and(|surface| surface.binding.generation() == generation)
        {
            return false;
        }
        if self.desktop.candidate.as_ref().is_some_and(|surface| {
            surface.session.diagnostics().desired_revision != Some(self.desktop.desired_revision)
        }) {
            self.retire_wallpaper_candidate();
            return true;
        }
        if let Some(clock) = parse_page_clock(event) {
            self.desktop
                .candidate
                .as_mut()
                .expect("candidate")
                .page_clock = Some(clock);
            return true;
        }
        if event.starts_with("wallpaper_media_failed ")
            || event.starts_with("wallpaper_gl_failed ")
            || event == "wallpaper_mount_failed"
        {
            self.fail_wallpaper_candidate(event.chars().take(256).collect());
            return true;
        }
        let surface = self.desktop.candidate.as_mut().expect("candidate");
        match surface.binding.parse(event) {
            Some(PageEvent::Handshake) => {
                if surface.session.page_handshake(generation) {
                    surface.load_media_page();
                }
            }
            Some(PageEvent::FirstFrame(kind)) => {
                let expected = surface.media_frame_kind();
                if kind == expected && surface.session.frame_submitted(generation, kind) {
                    surface.frame_wait_since = None;
                    surface.session.start_presentation(Instant::now());
                    self.promote_wallpaper_candidate();
                }
            }
            Some(PageEvent::MediaPosition(position)) => {
                surface.session.record_media_position(generation, position);
            }
            Some(PageEvent::MediaPaused(token)) => {
                surface
                    .session
                    .confirm_media_pause(generation, token, Instant::now());
            }
            _ => {}
        }
        true
    }

    pub(super) fn tick_media_wallpaper(&mut self, loop_target: &EventLoopWindowTarget<()>) {
        if self.desktop.application_gate.stable()
            == Some(crate::wallpaper::config::RuleAction::Stop)
        {
            // Stop releases both dynamic and static presentation resources. The
            // selected item and its checkpoint remain runtime intent, so resume
            // goes through fresh admission without advancing the playlist.
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            if self
                .desktop
                .prepared
                .as_ref()
                .is_some_and(|prepared| prepared.static_poster)
            {
                self.desktop.policy_poster = self.desktop.prepared.take();
            }
            self.cancel_wallpaper_transition();
            self.close_wallpaper_handoff();
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.desktop.policy_released = true;
            return;
        }
        if self.desktop.policy_poster.is_some() && self.wallpaper_render_allowed() {
            self.desktop.prepared = self.desktop.policy_poster.take();
            self.desktop.policy_released = false;
        }
        if self.desktop.policy_released
            && self.wallpaper_render_allowed()
            && self.wallpaper_target_running(&self.desktop.configuration)
            && self.desktop.failed_revision != Some(self.desktop.desired_revision)
        {
            // A normal Stop/resume cycle must not spend the three-attempt
            // renderer failure budget. Fresh admission still owns failures.
            let result = if self.desktop.configuration.builtin().is_some() {
                self.stage_builtin_wallpaper(loop_target)
            } else {
                self.ensure_media_wallpaper(loop_target)
            };
            match result {
                Ok(()) => self.desktop.policy_released = false,
                Err(error) => {
                    self.desktop.apply_error = Some(error.to_string());
                    self.desktop.failed_revision = Some(self.desktop.desired_revision);
                }
            }
        }
        let hard_pause = self.policy.session_unavailable
            || self.desktop.monitor_missing
            || self.policy.display_off
            || self.wallpaper_power != native::PowerState::Ac;
        if hard_pause {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            if self
                .desktop
                .surface
                .as_ref()
                .is_some_and(|surface| surface.session.media().is_some())
            {
                self.retire_wallpaper_surface();
                self.desktop.page_ready = false;
                self.desktop.visible = false;
            }
            if let Some(surface) = self.desktop.candidate.take() {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
            }
            return;
        }
        if let Some(surface) = self.desktop.candidate.as_ref() {
            if surface.session.diagnostics().desired_revision != Some(self.desktop.desired_revision)
            {
                self.retire_wallpaper_candidate();
            } else if surface.session.media_pause_expired(Instant::now()) {
                self.fail_wallpaper_candidate(
                    "media_pause_unconfirmed: 作品未在 2 秒内确认暂停".into(),
                );
            } else if surface
                .frame_wait_since
                .is_some_and(|at| at.elapsed() > HEARTBEAT_STALE)
                || (surface.created_at.elapsed() > HEARTBEAT_STALE && surface.page_clock.is_none())
            {
                self.fail_wallpaper_candidate("作品未在期限内提交首帧，保留原画面".into());
            } else if !self.wallpaper_render_allowed() {
                self.retain_static_wallpaper_poster();
                self.retire_wallpaper_candidate();
                self.desktop.policy_released = true;
            } else if surface.first_frame_ready() {
                self.promote_wallpaper_candidate();
            } else if surface.page_clock.is_some() {
                let surface = self.desktop.candidate.as_mut().expect("candidate");
                surface.start(surface.configuration.presentation().fps);
                surface.frame_wait_since.get_or_insert_with(Instant::now);
            }
        }
        if let Some(generation) = self
            .desktop
            .surface
            .as_ref()
            .filter(|surface| surface.session.media_pause_expired(Instant::now()))
            .map(|surface| surface.binding.generation())
        {
            self.handle_wallpaper_page(
                generation,
                "wallpaper_media_failed media_pause_unconfirmed",
            );
        }
        let paused_for = self
            .desktop
            .surface
            .as_ref()
            .and_then(|surface| surface.session.diagnostics().paused_at)
            .map(|at| at.elapsed());
        if paused_for.is_none() {
            self.desktop.pause_capture_attempted = false;
        }
        if paused_for.is_some_and(|elapsed| elapsed >= Duration::from_secs(285))
            && !self.wallpaper_hidden
            && !self.wallpaper_render_allowed()
            && !self.desktop.pause_capture_attempted
        {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            if let Err(error) = self.prepare_wallpaper_handoff() {
                self.desktop.apply_error = Some(error.to_string());
            }
            if let Some(handoff) = self.desktop.handoff.as_mut() {
                handoff.pause_retained = true;
                self.desktop.pause_capture_attempted = true;
            }
            if self.desktop.surface.is_none() {
                self.desktop.policy_released = true;
            }
        }
        if paused_for.is_some_and(|elapsed| elapsed >= Duration::from_secs(300)) {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            self.retire_wallpaper_surface();
            self.desktop.page_ready = false;
            self.desktop.visible = false;
            self.desktop.policy_released = true;
        }
        if self.desktop.prepared.is_some() {
            if let Err(error) = self.try_stage_wallpaper(loop_target) {
                self.desktop.apply_error = Some(error.to_string());
            }
        }
        if self.wallpaper_target_running(&self.desktop.configuration)
            && self.desktop.configuration.builtin().is_none()
            && self.desktop.candidate.is_none()
            && self.desktop.prepared.is_none()
            && self.desktop.selection.is_none()
            && self.desktop.failed_revision != Some(self.desktop.desired_revision)
            && !self.desktop.surface.as_ref().is_some_and(|surface| {
                same_render_intent(&surface.configuration, &self.desktop.configuration)
                    && (!self.is_mirror_target() || self.mirror_surface_matches(surface))
            })
        {
            if let Err(error) = self.ensure_media_wallpaper(loop_target) {
                self.desktop.apply_error = Some(error.to_string());
            }
        }
    }
}

#[cfg(test)]
mod playback_tests {
    use super::*;
    use crate::wallpaper::{
        media::{Container, MediaProbe},
        page_events::PageBinding,
        target_planner::AssetRef,
    };

    #[test]
    fn resume_checkpoint_matches_revision_package_asset_variant_and_actual_bytes() {
        let reference = AssetRef {
            package_hash: "a".repeat(64),
            asset_id: "video".into(),
            variant_id: None,
        };
        let mut metadata = MediaProbe {
            container: Container::Webm,
            codec: "vp8".into(),
            profile: None,
            encoded_width: 64,
            encoded_height: 48,
            display_width: 64,
            display_height: 48,
            rotation_degrees: 0,
            pixel_aspect_ratio: 1.0,
            duration_ms: Some(3000),
            source_fps: Some(10.0),
            fps_upper_bound: Some(10.0),
        };
        let mut resume = PlaybackResume {
            revision: 42,
            binding: PageBinding::new(7).unwrap(),
            reference: reference.clone(),
            content_key: "b".repeat(64),
            duration_ms: 3000,
            position_ms: 1500,
        };
        let key = resume.content_key.clone();
        assert_eq!(
            resume.position_for(42, &reference, &key, &metadata),
            Some(1500)
        );
        assert_eq!(resume.position_for(43, &reference, &key, &metadata), None);
        assert_eq!(
            resume.position_for(42, &reference, &"c".repeat(64), &metadata),
            None
        );
        for changed in [
            AssetRef {
                package_hash: "d".repeat(64),
                ..reference.clone()
            },
            AssetRef {
                asset_id: "other".into(),
                ..reference.clone()
            },
            AssetRef {
                variant_id: Some("other".into()),
                ..reference.clone()
            },
        ] {
            assert_eq!(resume.position_for(42, &changed, &key, &metadata), None);
        }
        metadata.container = Container::Image;
        assert_eq!(resume.position_for(42, &reference, &key, &metadata), None);
        metadata.container = Container::Webm;
        metadata.duration_ms = Some(2000);
        assert_eq!(resume.position_for(42, &reference, &key, &metadata), None);
        let receipt = |binding: &PageBinding, position: u64| {
            let mut value = serde_json::to_value(binding).unwrap();
            value["event"] = "mediaPosition".into();
            value["positionMs"] = position.into();
            format!("wallpaper_session {value}")
        };
        let current = receipt(&resume.binding, 1700);
        assert!(!resume.observe(43, 7, &current));
        assert!(!resume.observe(42, 8, &current));
        assert!(!resume.observe(42, 7, &receipt(&PageBinding::new(7).unwrap(), 1600)));
        assert_eq!(resume.position_at(42), Some(1500));
        assert!(resume.observe(42, 7, &current));
        assert_eq!(resume.position_at(42), Some(1700));
        assert_eq!(resume.position_at(43), None);
        assert!(resume.observe(42, 7, &receipt(&resume.binding, 3000)));
        assert_eq!(
            resume.position_at(42),
            Some(1700),
            "out-of-range receipt leaves the last valid position intact"
        );
    }
}
