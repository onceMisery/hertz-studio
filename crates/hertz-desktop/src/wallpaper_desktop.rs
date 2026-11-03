// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native single-media selection and controller handoff. Expensive work stays in LibraryService.
use super::*;
use crate::wallpaper::{
    api,
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

pub(super) struct PendingApply {
    request: api::Request,
    owner: u64,
    draft: crate::wallpaper::settings_drafts::Draft,
    reply: ApiReply,
}

pub(super) struct SelectionTask {
    id: u64,
    pub(super) cancel: Arc<AtomicBool>,
    configuration: config::WallpaperConfig,
    revision: u64,
    monitor: native::WallpaperMonitor,
    pub(super) apply: Option<PendingApply>,
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
    }
}

pub(super) struct Prepared {
    media: Option<ResolvedMedia>,
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
    }
}

fn same_config(a: &config::WallpaperConfig, b: &config::WallpaperConfig) -> bool {
    serde_json::to_value(a).expect("wallpaper config")
        == serde_json::to_value(b).expect("wallpaper config")
}

fn target(
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
    pub(super) fn tick_wallpaper_follow(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if !self.config.wallpaper.follows_hertz()
            || !(self.config.wallpaper.enabled || self.wallpaper_forced)
            || self.wallpaper_media_failed_revision == Some(self.config.revision)
            || self.wallpaper_recovery_terminal
            || !self.wallpaper_render_allowed(&self.config.wallpaper)
        {
            return;
        }
        let desired =
            crate::wallpaper::follow::resolve(&self.config.wallpaper, self.wallpaper_last.as_ref());
        let pending_changed = self
            .wallpaper_candidate
            .as_ref()
            .is_some_and(|surface| surface.runtime_builtin != desired);
        if pending_changed {
            self.cancel_wallpaper_transition();
        }
        if self.wallpaper_candidate.is_some() || self.wallpaper_prepared.is_some() {
            return;
        }
        if pending_changed
            || self
                .wallpaper
                .as_ref()
                .is_some_and(|surface| surface.runtime_builtin != desired)
        {
            if let Err(error) = self.stage_builtin_wallpaper(target) {
                self.wallpaper_apply_error = Some(error.to_string());
            }
        }
    }

    pub(super) fn is_media_apply(&self, request: &api::Request, owner: u64) -> bool {
        match request.typed() {
            Ok(api::Command::Apply {
                draft_id,
                draft_revision,
            }) => self
                .settings_drafts
                .get(owner, &draft_id, draft_revision)
                .is_ok_and(|draft| {
                    matches!(draft.wallpaper.main().selection, Selection::Package { .. })
                }),
            _ => false,
        }
    }

    pub(super) fn begin_media_apply(
        &mut self,
        request: api::Request,
        owner: u64,
        reply: ApiReply,
        slot: crate::wallpaper::service::Slot,
    ) -> JobResult<()> {
        let api::Command::Apply {
            draft_id,
            draft_revision,
        } = request.typed()?
        else {
            return Err(JobError::invalid_input("需要应用命令"));
        };
        let draft = self
            .settings_drafts
            .get(owner, &draft_id, draft_revision)?
            .clone();
        draft.check_apply(
            request.expected_revision.expect("validated revision"),
            &self.config,
        )?;
        if self.position_edit.is_some() || self.save_due.is_some() {
            return Err(JobError::new("conflict", "请先完成当前设置修改"));
        }
        validate_configured_presentation(&draft.wallpaper).map_err(JobError::invalid_input)?;
        if draft.lyrics.locked && self.tray.is_none() {
            return Err(JobError::new(
                "tray_unavailable",
                "托盘不可用，暂时无法锁定歌词",
            ));
        }
        let configuration = draft.wallpaper.clone();
        let apply = PendingApply {
            request,
            owner,
            draft,
            reply,
        };
        self.close_preview();
        self.begin_wallpaper_selection(configuration, Some(apply), slot)
    }

    fn begin_wallpaper_selection(
        &mut self,
        configuration: config::WallpaperConfig,
        apply: Option<PendingApply>,
        slot: crate::wallpaper::service::Slot,
    ) -> JobResult<()> {
        if self.wallpaper_selection.is_some() {
            return Err(JobError::new(
                "budget_busy",
                "已有作品正在准备，请等待完成或取消原草稿",
            ));
        }
        validate_configured_presentation(&configuration).map_err(JobError::invalid_input)?;
        let Selection::Package {
            work_key,
            package_hash,
        } = &configuration.main().selection
        else {
            return Err(JobError::invalid_input("需要固定作品版本"));
        };
        let monitor =
            resolve_wallpaper_monitor_or_primary(&native::wallpaper_monitors(), &configuration)
                .ok_or_else(|| JobError::new("display_missing", "目标显示器未连接，未改写选择"))?;
        let selection = crate::wallpaper::selection_plan::Request {
            work_key: work_key.clone(),
            package_hash: package_hash.clone(),
            target: target(&configuration, &monitor),
        };
        self.wallpaper_generation += 1;
        let id = self.wallpaper_generation;
        let cancel = Arc::new(AtomicBool::new(false));
        let proxy = self.proxy.clone();
        self.wallpaper_library.resolve_selection_reserved(
            selection,
            Arc::clone(&cancel),
            slot,
            move |result| {
                let _ = proxy.send_event(UserEvent::WallpaperSelection(id, result.map(Box::new)));
            },
        )?;
        self.wallpaper_selection = Some(SelectionTask {
            id,
            cancel,
            configuration,
            revision: self.config.revision,
            monitor,
            apply,
        });
        Ok(())
    }

    fn finish_media_request(&mut self, apply: PendingApply, result: JobResult<serde_json::Value>) {
        let mut receipt = api::response(Some(&apply.request.request_id), result, None);
        receipt["configRevision"] = receipt["result"]["configRevision"]
            .as_u64()
            .unwrap_or(self.config.revision)
            .into();
        self.wallpaper_library
            .finish_local(&apply.request, &receipt);
        self.send_wallpaper_management(apply.reply, receipt);
    }

    pub(super) fn finish_wallpaper_selection(
        &mut self,
        id: u64,
        result: std::result::Result<ResolvedMedia, crate::wallpaper::selection_plan::Failure>,
        loop_target: &EventLoopWindowTarget<UserEvent>,
    ) {
        if !self
            .wallpaper_selection
            .as_ref()
            .is_some_and(|task| task.id == id)
        {
            return;
        }
        let task = self.wallpaper_selection.take().expect("selection task");
        let result = if task.cancel.load(Ordering::Acquire) {
            Err(JobError::new("cancelled", "作品准备已取消并退出").into())
        } else {
            result
        };
        let media = match result {
            Ok(media) => media,
            Err(failure) => {
                let error = failure.error;
                if let Some(apply) = task.apply {
                    self.finish_media_request(apply, Err(error));
                } else if error.code != "cancelled"
                    && task.revision == self.config.revision
                    && same_config(&task.configuration, &self.config.wallpaper)
                {
                    self.wallpaper_playback = None;
                    self.wallpaper_media_failed_revision = Some(task.revision);
                    self.wallpaper_apply_error = Some(error.to_string());
                    if self.wallpaper.is_none() {
                        if let Some(poster) = failure.poster {
                            self.wallpaper_prepared = Some(Prepared {
                                media: Some(*poster),
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
                    self.send_settings_status(self.wallpaper_apply_error.as_deref(), None);
                }
                return;
            }
        };
        if let Some(apply) = task.apply {
            let result = (|| {
                self.settings_drafts
                    .get(apply.owner, &apply.draft.id, apply.draft.revision)?;
                apply.draft.check_apply(
                    apply.request.expected_revision.expect("validated revision"),
                    &self.config,
                )?;
                if self.save_due.is_some() || self.position_edit.is_some() {
                    return Err(JobError::new("conflict", "准备期间设置已变化，未保存候选"));
                }
                let current_monitor = resolve_wallpaper_monitor_or_primary(
                    &native::wallpaper_monitors(),
                    &task.configuration,
                )
                .ok_or_else(|| {
                    JobError::new("display_missing", "准备期间目标显示器断开，未保存候选")
                })?;
                if current_monitor.display_id() != task.monitor.display_id()
                    || monitor_geometry_changed(&current_monitor, &task.monitor)
                {
                    return Err(JobError::new(
                        "display_changed",
                        "准备期间显示器尺寸已变化，请重新应用",
                    ));
                }
                let intent = crate::config_journal::Intent {
                    request_id: apply.request.request_id.clone(),
                    payload_digest: apply.request.digest(),
                    command: apply.request.command.clone(),
                    caller_sid: crate::config_journal::caller_sid().map_err(|error| {
                        JobError::new("identity_unavailable", error.to_string())
                    })?,
                };
                let mut next = self.config.clone();
                next.wallpaper = task.configuration.clone();
                next.lyrics = apply.draft.lyrics.clone();
                config::commit_request(&mut self.config, next, &intent).map_err(|error| {
                    JobError::new(
                        crate::config_journal::error_code(&error, "config_write_failed"),
                        error.to_string(),
                    )
                })
            })();
            match result {
                Ok(operation) => {
                    self.retire_wallpaper_candidate();
                    self.wallpaper_prepared = Some(Prepared {
                        media: Some(media),
                        static_poster: false,
                        configuration: task.configuration.clone(),
                        revision: self.config.revision,
                        monitor: task.monitor,
                    });
                    self.wallpaper_media_failed_revision = None;
                    let error = self
                        .apply_saved_wallpaper_settings(task.configuration, loop_target)
                        .err();
                    self.send_settings_status(error.as_deref(), Some("已应用"));
                    let receipt = if operation.state == crate::config_journal::State::Pending {
                        Err(JobError::new(
                            "operation_pending",
                            "配置写入完成，正在核对提交记录，请按原请求查询",
                        ))
                    } else {
                        Ok(serde_json::to_value(operation).expect("configuration receipt"))
                    };
                    self.finish_media_request(apply, receipt);
                }
                Err(error) => self.finish_media_request(apply, Err(error)),
            }
        } else if task.revision == self.config.revision
            && same_config(&task.configuration, &self.config.wallpaper)
        {
            self.wallpaper_prepared = Some(Prepared {
                media: Some(media),
                static_poster: false,
                configuration: task.configuration,
                revision: task.revision,
                monitor: task.monitor,
            });
            if let Err(error) = self.try_stage_wallpaper(loop_target) {
                self.wallpaper_apply_error = Some(error.to_string());
            }
        }
    }

    pub(super) fn ensure_media_wallpaper(
        &mut self,
        loop_target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<()> {
        validate_configured_presentation(&self.config.wallpaper).map_err(anyhow::Error::msg)?;
        if self.wallpaper.as_ref().is_some_and(|surface| {
            same_config(&surface.configuration, &self.config.wallpaper)
                && (!surface.static_poster
                    || self.wallpaper_media_failed_revision == Some(self.config.revision))
                && native::wallpaper_alive(surface.hwnd())
        }) {
            return Ok(());
        }
        if self.wallpaper_candidate.is_some() || self.wallpaper_selection.is_some() {
            return Ok(());
        }
        if self.wallpaper_prepared.is_some() {
            return self.try_stage_wallpaper(loop_target);
        }
        if self.wallpaper_media_failed_revision == Some(self.config.revision) {
            bail!("当前作品未能呈现，请明确重试或重新选择");
        }
        if !self.wallpaper_render_allowed(&self.config.wallpaper) {
            return Ok(());
        }
        let slot = self
            .wallpaper_library
            .reserve()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        self.begin_wallpaper_selection(self.config.wallpaper.clone(), None, slot)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
    }

    pub(super) fn wallpaper_render_allowed(&self, configuration: &config::WallpaperConfig) -> bool {
        policy::renderable(&policy::PolicyInputs {
            enabled: true,
            wallpaper: configuration,
            manual_pause: self.wallpaper_hidden,
            fullscreen: self.wallpaper_fullscreen_gate.stable(),
            session_unavailable: self.policy.session_unavailable,
            display_off: self.policy.display_off,
            display_missing: self.wallpaper_monitor_missing,
            power: self.wallpaper_power,
            has_surface: true,
            page_ready: true,
        })
    }

    pub(super) fn stage_builtin_wallpaper(
        &mut self,
        loop_target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<()> {
        let configuration = self.config.wallpaper.clone();
        let monitor =
            resolve_wallpaper_monitor_or_primary(&native::wallpaper_monitors(), &configuration)
                .ok_or_else(|| anyhow::anyhow!("目标显示器未连接"))?;
        self.wallpaper_prepared = Some(Prepared {
            media: None,
            static_poster: false,
            configuration,
            revision: self.config.revision,
            monitor,
        });
        self.try_stage_wallpaper(loop_target)
    }

    fn try_stage_wallpaper(
        &mut self,
        loop_target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<()> {
        let Some(prepared) = self.wallpaper_prepared.as_ref() else {
            return Ok(());
        };
        if prepared.revision != self.config.revision
            || !same_config(&prepared.configuration, &self.config.wallpaper)
        {
            self.wallpaper_prepared = None;
            return Ok(());
        }
        if !self.wallpaper_render_allowed(&prepared.configuration)
            || self.wallpaper_candidate.is_some()
        {
            return Ok(());
        }
        // Preparation can wait through a policy pause. Its fixed target must still match
        // the real display immediately before admission; otherwise resolve a fresh plan.
        let Some(monitor) = resolve_wallpaper_monitor_or_primary(
            &native::wallpaper_monitors(),
            &prepared.configuration,
        ) else {
            return Ok(());
        };
        if monitor.display_id() != prepared.monitor.display_id()
            || monitor_geometry_changed(&monitor, &prepared.monitor)
        {
            let mut prepared = self.wallpaper_prepared.take().expect("prepared selection");
            if prepared.media.is_some() && !prepared.static_poster {
                let slot = self
                    .wallpaper_library
                    .reserve()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                return self
                    .begin_wallpaper_selection(prepared.configuration, None, slot)
                    .map_err(|error| anyhow::anyhow!(error.to_string()));
            }
            if prepared.static_poster {
                if let Some(media) = prepared.media.take() {
                    prepared.media = Some(
                        media.retarget_static_image(target(&prepared.configuration, &monitor))?,
                    );
                }
            }
            self.wallpaper_prepared = Some(Prepared {
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
                self.wallpaper_prepared = None;
                self.wallpaper_media_failed_revision = Some(self.config.revision);
                return Err(error);
            }
        }
        let prepared = self.wallpaper_prepared.take().expect("prepared selection");
        self.wallpaper_generation += 1;
        let generation = self.wallpaper_generation;
        let mut surface = match create_presentation(
            loop_target,
            self.proxy.clone(),
            generation,
            prepared.revision,
            prepared.configuration,
            prepared.monitor,
            PresentationWindow::Desktop { candidate: true },
        ) {
            Ok(surface) => surface,
            Err(error) => {
                self.wallpaper_media_failed_revision = Some(self.config.revision);
                return Err(error);
            }
        };
        surface.static_poster = prepared.static_poster;
        surface.runtime_builtin =
            crate::wallpaper::follow::resolve(&surface.configuration, self.wallpaper_last.as_ref());
        if let Some(media) = prepared.media {
            let resume = self.wallpaper_playback.as_ref().and_then(|resume| {
                resume.position_for(
                    prepared.revision,
                    media.reference(),
                    media.content_key(),
                    &media.input().metadata,
                )
            });
            if resume.is_none() {
                self.wallpaper_playback = None;
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
                self.wallpaper_media_failed_revision = Some(self.config.revision);
                return Err(anyhow::anyhow!(error.to_string()));
            }
            if let Some(position) = resume {
                surface.session.record_media_position(generation, position);
            }
        }
        self.wallpaper_candidate = Some(surface);
        Ok(())
    }

    fn retire_wallpaper_candidate(&mut self) {
        if let Some(surface) = self.wallpaper_candidate.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
    }

    pub(super) fn cancel_wallpaper_transition(&mut self) {
        if let Some(task) = &self.wallpaper_selection {
            task.cancel.store(true, Ordering::Release);
        }
        self.wallpaper_prepared = None;
        if let Some(surface) = self.wallpaper_candidate.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
    }

    fn fail_wallpaper_candidate(&mut self, message: String) {
        self.wallpaper_playback = None;
        if let Some(surface) = self.wallpaper_candidate.take() {
            if self.wallpaper.is_none() && self.wallpaper_handoff.is_none() {
                self.wallpaper_prepared = self.poster_for_surface(&surface);
            }
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        self.wallpaper_media_failed_revision = Some(self.config.revision);
        self.wallpaper_apply_error = Some(message);
        self.send_settings_status(self.wallpaper_apply_error.as_deref(), None);
    }

    fn poster_for_surface(&self, surface: &WallpaperSurface) -> Option<Prepared> {
        if surface.static_poster || !same_config(&surface.configuration, &self.config.wallpaper) {
            return None;
        }
        Some(Prepared {
            media: Some(surface.session.media()?.poster()?.clone()),
            static_poster: true,
            configuration: surface.configuration.clone(),
            revision: self.config.revision,
            monitor: surface.monitor.clone(),
        })
    }

    pub(super) fn prepare_failed_wallpaper_poster(&mut self) {
        self.wallpaper_playback = None;
        if self.wallpaper_prepared.is_none() && self.wallpaper_candidate.is_none() {
            self.wallpaper_prepared = self
                .wallpaper
                .as_ref()
                .and_then(|surface| self.poster_for_surface(surface));
        }
    }

    pub(super) fn retain_static_wallpaper_poster(&mut self) {
        if let Some(surface) = self
            .wallpaper
            .as_ref()
            .filter(|surface| surface.static_poster)
            .or_else(|| {
                self.wallpaper_candidate
                    .as_ref()
                    .filter(|surface| surface.static_poster)
            })
        {
            if self.wallpaper_prepared.is_none()
                && same_config(&surface.configuration, &self.config.wallpaper)
            {
                self.wallpaper_prepared = Some(Prepared {
                    media: surface.session.media().cloned(),
                    static_poster: true,
                    configuration: surface.configuration.clone(),
                    revision: self.config.revision,
                    monitor: surface.monitor.clone(),
                });
            }
        }
    }

    pub(super) fn retain_wallpaper_playback(&mut self) {
        let Some(surface) = self.wallpaper.as_ref().filter(|surface| {
            !surface.static_poster
                && surface.first_frame_ready()
                && same_config(&surface.configuration, &self.config.wallpaper)
                && surface.session.diagnostics().desired_revision == Some(self.config.revision)
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
        self.wallpaper_playback = Some(PlaybackResume {
            revision: self.config.revision,
            binding: surface.binding.clone(),
            reference: media.reference().clone(),
            content_key: media.content_key().into(),
            duration_ms,
            position_ms,
        });
    }

    pub(super) fn retry_media_wallpaper(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if self
            .wallpaper_prepared
            .as_ref()
            .is_some_and(|prepared| prepared.static_poster)
        {
            self.wallpaper_prepared = None;
        }
        if let Err(error) = self.ensure_media_wallpaper(target) {
            self.wallpaper_apply_error = Some(error.to_string());
        }
    }

    fn promote_wallpaper_candidate(&mut self) {
        let Some(surface) = self.wallpaper_candidate.as_ref() else {
            return;
        };
        if !surface.first_frame_ready() || !self.wallpaper_render_allowed(&surface.configuration) {
            return;
        }
        if let Err(error) = native::wallpaper_opacity(surface.hwnd(), 255) {
            self.fail_wallpaper_candidate(error.to_string());
            return;
        }
        let surface = self.wallpaper_candidate.take().expect("ready candidate");
        self.wallpaper_playback = None;
        self.retire_wallpaper_surface();
        self.wallpaper = Some(surface);
        self.handoff_wait_for_reveal(
            self.wallpaper
                .as_ref()
                .expect("promoted candidate")
                .binding
                .generation(),
        );
        self.wallpaper_page_ready = true;
        self.wallpaper_monitor_missing = false;
        if !self
            .wallpaper
            .as_ref()
            .is_some_and(|surface| surface.static_poster)
        {
            self.wallpaper_apply_error = None;
        }
        self.reset_wallpaper_page_stats();
        self.wallpaper_heartbeat_at = Some(Instant::now());
        self.recompute_wallpaper();
        self.send_settings_status(None, None);
    }

    pub(super) fn handle_candidate_page(&mut self, generation: u64, event: &str) -> bool {
        if !self
            .wallpaper_candidate
            .as_ref()
            .is_some_and(|surface| surface.binding.generation() == generation)
        {
            return false;
        }
        if self.wallpaper_candidate.as_ref().is_some_and(|surface| {
            surface.session.diagnostics().desired_revision != Some(self.config.revision)
        }) {
            self.retire_wallpaper_candidate();
            return true;
        }
        if let Some(clock) = parse_page_clock(event) {
            self.wallpaper_candidate
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
        let surface = self.wallpaper_candidate.as_mut().expect("candidate");
        match surface.binding.parse(event) {
            Some(PageEvent::Handshake) => {
                if surface.session.page_handshake(generation) {
                    surface.load_media_page();
                }
            }
            Some(PageEvent::FirstFrame(kind)) => {
                let expected = surface.media_frame_kind();
                if kind == expected && surface.session.frame_submitted(generation, kind) {
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

    pub(super) fn tick_media_wallpaper(&mut self, loop_target: &EventLoopWindowTarget<UserEvent>) {
        if let Some(task) = &self.wallpaper_selection {
            if let Some(apply) = &task.apply {
                if self
                    .settings_drafts
                    .get(apply.owner, &apply.draft.id, apply.draft.revision)
                    .is_err()
                {
                    task.cancel.store(true, Ordering::Release);
                }
            }
        }
        let hard_pause = self.policy.session_unavailable
            || self.wallpaper_monitor_missing
            || self.policy.display_off
            || self.wallpaper_power != native::PowerState::Ac;
        if hard_pause {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            if self
                .wallpaper
                .as_ref()
                .is_some_and(|surface| surface.session.media().is_some())
            {
                self.retire_wallpaper_surface();
                self.wallpaper_page_ready = false;
                self.wallpaper_visible = false;
            }
            if let Some(surface) = self.wallpaper_candidate.take() {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
            }
            return;
        }
        if let Some(surface) = self.wallpaper_candidate.as_ref() {
            if surface.session.diagnostics().desired_revision != Some(self.config.revision) {
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
            } else if !self.wallpaper_render_allowed(&surface.configuration) {
                if surface.session.media().is_some_and(|media| {
                    media.input().metadata.container != crate::wallpaper::media::Container::Image
                }) {
                    // A candidate has no presented frame to preserve. In particular,
                    // loading video cannot use the ready-only soft-pause proof.
                    // Close its real controller now and requalify on resume.
                    self.retire_wallpaper_candidate();
                } else {
                    let surface = self.wallpaper_candidate.as_mut().expect("candidate");
                    surface.stop();
                    surface.frame_wait_since = None;
                }
            } else if surface.first_frame_ready() {
                self.promote_wallpaper_candidate();
            } else if surface.page_clock.is_some() {
                let surface = self.wallpaper_candidate.as_mut().expect("candidate");
                surface.start(surface.configuration.presentation().fps);
                surface.frame_wait_since.get_or_insert_with(Instant::now);
            }
        }
        if let Some(generation) = self
            .wallpaper
            .as_ref()
            .filter(|surface| surface.session.media_pause_expired(Instant::now()))
            .map(|surface| surface.binding.generation())
        {
            self.handle_wallpaper_page(
                generation,
                "wallpaper_media_failed media_pause_unconfirmed",
            );
        }
        if self.wallpaper.as_ref().is_some_and(|surface| {
            surface.session.media().is_some()
                && surface
                    .session
                    .diagnostics()
                    .paused_at
                    .is_some_and(|at| at.elapsed() >= Duration::from_secs(300))
        }) {
            self.retain_wallpaper_playback();
            self.retain_static_wallpaper_poster();
            self.retire_wallpaper_surface();
            self.wallpaper_page_ready = false;
            self.wallpaper_visible = false;
        }
        if self.wallpaper_prepared.is_some() {
            if let Err(error) = self.try_stage_wallpaper(loop_target) {
                self.wallpaper_apply_error = Some(error.to_string());
            }
        }
        if self.config.wallpaper.enabled
            && self.config.wallpaper.builtin().is_none()
            && self.wallpaper_candidate.is_none()
            && self.wallpaper_prepared.is_none()
            && self.wallpaper_selection.is_none()
            && self.wallpaper_media_failed_revision != Some(self.config.revision)
            && !self
                .wallpaper
                .as_ref()
                .is_some_and(|surface| same_config(&surface.configuration, &self.config.wallpaper))
        {
            if let Err(error) = self.ensure_media_wallpaper(loop_target) {
                self.wallpaper_apply_error = Some(error.to_string());
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
