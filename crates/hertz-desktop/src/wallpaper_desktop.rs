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

pub(super) struct Prepared {
    media: Option<ResolvedMedia>,
    configuration: config::WallpaperConfig,
    revision: u64,
    monitor: native::WallpaperMonitor,
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

    fn finish_media_request(&self, apply: PendingApply, result: JobResult<serde_json::Value>) {
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
        result: JobResult<ResolvedMedia>,
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
            Err(JobError::new("cancelled", "作品准备已取消并退出"))
        } else {
            result
        };
        let media = match result {
            Ok(media) => media,
            Err(error) => {
                if let Some(apply) = task.apply {
                    self.finish_media_request(apply, Err(error));
                } else if error.code != "cancelled" {
                    self.wallpaper_media_failed_revision = Some(task.revision);
                    self.wallpaper_apply_error = Some(error.to_string());
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

    fn wallpaper_render_allowed(&self, configuration: &config::WallpaperConfig) -> bool {
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
            let prepared = self.wallpaper_prepared.take().expect("prepared selection");
            if prepared.media.is_some() {
                let slot = self
                    .wallpaper_library
                    .reserve()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                return self
                    .begin_wallpaper_selection(prepared.configuration, None, slot)
                    .map_err(|error| anyhow::anyhow!(error.to_string()));
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
        if let Some(media) = prepared.media {
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
        if let Some(surface) = self.wallpaper_candidate.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        self.wallpaper_media_failed_revision = Some(self.config.revision);
        self.wallpaper_apply_error = Some(message);
        self.send_settings_status(self.wallpaper_apply_error.as_deref(), None);
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
        self.retire_wallpaper_surface();
        self.wallpaper = Some(surface);
        self.wallpaper_page_ready = true;
        self.wallpaper_monitor_missing = false;
        self.wallpaper_apply_error = None;
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
        if event.starts_with("wallpaper_media_failed ") || event == "wallpaper_mount_failed" {
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
            } else if surface
                .frame_wait_since
                .is_some_and(|at| at.elapsed() > HEARTBEAT_STALE)
                || (surface.created_at.elapsed() > HEARTBEAT_STALE && surface.page_clock.is_none())
            {
                self.fail_wallpaper_candidate("作品未在期限内提交首帧，保留原画面".into());
            } else if !self.wallpaper_render_allowed(&surface.configuration) {
                let surface = self.wallpaper_candidate.as_mut().expect("candidate");
                surface.stop();
                surface.frame_wait_since = None;
            } else if surface.first_frame_ready() {
                self.promote_wallpaper_candidate();
            } else if surface.page_clock.is_some() {
                let surface = self.wallpaper_candidate.as_mut().expect("candidate");
                surface.start(surface.configuration.presentation().fps);
                surface.frame_wait_since.get_or_insert_with(Instant::now);
            }
        }
        if self.wallpaper.as_ref().is_some_and(|surface| {
            surface.session.media().is_some()
                && surface
                    .session
                    .diagnostics()
                    .paused_at
                    .is_some_and(|at| at.elapsed() >= Duration::from_secs(300))
        }) {
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
