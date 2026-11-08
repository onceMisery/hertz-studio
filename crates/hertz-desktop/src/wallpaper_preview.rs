// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! All settings previews share one native controller owner, typed readiness and exit barrier.
use super::wallpaper_handoff::Handoff;
use super::*;
use crate::wallpaper::{
    api,
    config::{LayoutMode, Selection},
    image_prepare::{ImageFit, ImagePurpose, ImageTarget},
    jobs::JobError,
    page_events::PageEvent,
    target_planner::ResolvedMedia,
};

type JobResult<T> = std::result::Result<T, JobError>;

enum PreviewContent {
    Builtin(Option<crate::wallpaper::config::BuiltinState>),
    Media(ResolvedMedia),
    Composition(crate::wallpaper::composition_plan::PreparedComposition),
}

pub(super) struct PreviewOwner {
    id: u64,
    owner: u64,
    draft: Option<(String, u64)>,
    pub(super) lease_id: String,
    pub(super) lease_until: Instant,
    cancel: Arc<AtomicBool>,
    configuration: config::WallpaperConfig,
    reference: Option<crate::wallpaper::playlist::FixedVersion>,
    configured_fps: u8,
    monitor: native::WallpaperMonitor,
    prepared: Option<PreviewContent>,
    pub(super) surface: Option<WallpaperSurface>,
    pub(super) frame: Option<Handoff>,
    error: Option<String>,
    heartbeat_at: Instant,
}
impl PreviewOwner {
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
            || self.surface.as_ref().is_some_and(|surface| {
                surface
                    .configuration
                    .references_package(work_key, package_hash)
                    || surface
                        .runtime_reference
                        .as_ref()
                        .is_some_and(|v| v.matches(work_key, package_hash))
            })
            || self.frame.as_ref().is_some_and(|frame| {
                frame
                    .configuration
                    .references_package(work_key, package_hash)
                    || frame
                        .runtime_reference
                        .as_ref()
                        .is_some_and(|v| v.matches(work_key, package_hash))
            })
    }
}

fn preview_monitor() -> JobResult<native::WallpaperMonitor> {
    let mut monitor = native::wallpaper_monitors()
        .into_iter()
        .find(|monitor| monitor.primary)
        .ok_or_else(|| JobError::new("display_missing", "当前没有可用显示器"))?;
    let width = (monitor.width / 2).clamp(1, 640);
    let height = (monitor.height / 2).clamp(1, 360);
    monitor.left += (monitor.width - width) / 2;
    monitor.top += (monitor.height - height) / 2;
    monitor.width = width;
    monitor.height = height;
    Ok(monitor)
}

/// The preview owns one canvas; its runtime projection never changes the full intent document.
fn preview_configuration(
    configuration: &config::WallpaperConfig,
    group_id: Option<&str>,
) -> JobResult<config::WallpaperConfig> {
    let selected = match group_id {
        Some(id) => configuration.groups.iter().find(|group| group.id == id),
        None => configuration.groups.first(),
    }
    .ok_or_else(|| JobError::new("group_not_found", "预览显示组不存在，请重新选择显示组"))?;
    let display = selected
        .displays
        .first()
        .ok_or_else(|| JobError::invalid_input("预览显示组没有显示器"))?;
    let mut group = selected.clone();
    group.mode = LayoutMode::Single;
    group.displays = vec![display.clone()];
    Ok(config::WallpaperConfig {
        groups: vec![group],
        ..configuration.clone()
    })
}

impl App {
    pub(super) fn work_preview_request(&self, request: &api::Request) -> bool {
        matches!(request.typed(), Ok(api::Command::PreviewAcquire { draft_id, .. } | api::Command::PreviewUpdate { draft_id, .. }) if draft_id.starts_with("work-"))
    }

    pub(super) fn begin_work_preview(
        &mut self,
        request: api::Request,
        owner: u64,
        reply: ApiReply,
        slot: crate::wallpaper::service::Slot,
    ) -> JobResult<()> {
        let (id, revision) = match request.typed()? {
            api::Command::PreviewAcquire {
                draft_id,
                draft_revision,
                ..
            }
            | api::Command::PreviewUpdate {
                draft_id,
                draft_revision,
                ..
            } => (draft_id, draft_revision),
            _ => return Err(JobError::invalid_input("需要作品预览命令")),
        };
        self.work_preview_epoch = self.work_preview_epoch.wrapping_add(1);
        let epoch = self.work_preview_epoch;
        let proxy = self.proxy.clone();
        self.wallpaper_library
            .read_work_document(id, revision, owner, slot, move |document| {
                let _ = proxy.send_event(UserEvent::WorkPreviewReady(
                    request,
                    owner,
                    epoch,
                    reply,
                    Box::new(document),
                ));
            })
    }

    pub(super) fn finish_work_preview(
        &mut self,
        request: api::Request,
        owner: u64,
        epoch: u64,
        reply: ApiReply,
        document: JobResult<crate::wallpaper::work_drafts::Document>,
        target: &EventLoopWindowTarget<()>,
    ) {
        let result = (|| {
            if epoch != self.work_preview_epoch {
                return Err(JobError::new("cancelled", "作品预览已被取消或替换"));
            }
            if owner == 0 || owner != self.settings_generation || self.settings.is_none() {
                return Err(JobError::new(
                    "settings_session_required",
                    "作品预览所属设置已关闭",
                ));
            }
            let document = document?;
            let (id, revision, lease, group_id) = match request.typed()? {
                api::Command::PreviewAcquire {
                    draft_id,
                    draft_revision,
                    group_id,
                } => {
                    if self.preview_active() {
                        return Err(JobError::new("preview_busy", "请先释放当前预览"));
                    }
                    (
                        draft_id,
                        draft_revision,
                        new_lease_id().map_err(JobError::invalid_input)?,
                        group_id,
                    )
                }
                api::Command::PreviewUpdate {
                    draft_id,
                    draft_revision,
                    lease_id,
                    group_id,
                } => {
                    self.check_preview_owner(owner, &lease_id)?;
                    (draft_id, draft_revision, lease_id, group_id)
                }
                _ => return Err(JobError::invalid_input("需要作品预览命令")),
            };
            let mut configuration =
                preview_configuration(&self.config.wallpaper, group_id.as_deref())?;
            let builtin = document.effective_builtin()?;
            configuration.main_mut().selection = Selection::Builtin {
                scene_id: builtin.scene_id,
                state_version: builtin.state_version,
                params: builtin.params,
            };
            configuration.main_mut().properties.clear();
            let slot = self.wallpaper_library.reserve()?;
            self.prepare_preview(configuration, Some((id, revision)), lease, slot, target)
        })();
        let receipt = api::response(Some(&request.request_id), result, None);
        self.wallpaper_library.finish_local(&request, &receipt);
        self.send_wallpaper_management(reply, receipt);
    }

    pub(super) fn preview_request(&self, request: &api::Request) -> bool {
        matches!(
            request.typed(),
            Ok(api::Command::PreviewAcquire { .. } | api::Command::PreviewUpdate { .. })
        )
    }

    pub(super) fn begin_preview(
        &mut self,
        request: &api::Request,
        owner: u64,
        slot: crate::wallpaper::service::Slot,
        target: &EventLoopWindowTarget<()>,
    ) -> JobResult<serde_json::Value> {
        self.work_preview_epoch = self.work_preview_epoch.wrapping_add(1);
        let (draft_id, draft_revision, lease_id, group_id) = match request.typed()? {
            api::Command::PreviewAcquire {
                draft_id,
                draft_revision,
                group_id,
            } => {
                if self.preview_active() {
                    return Err(JobError::new("preview_busy", "请先释放当前预览"));
                }
                (
                    draft_id,
                    draft_revision,
                    new_lease_id().map_err(JobError::invalid_input)?,
                    group_id,
                )
            }
            api::Command::PreviewUpdate {
                draft_id,
                draft_revision,
                lease_id,
                group_id,
            } => {
                self.check_preview_owner(owner, &lease_id)?;
                (draft_id, draft_revision, lease_id, group_id)
            }
            _ => return Err(JobError::invalid_input("需要预览命令")),
        };
        let draft = self
            .settings_drafts
            .get(owner, &draft_id, draft_revision)?
            .clone();
        draft.check_apply(draft.base_revision, &self.config)?;
        let configuration = preview_configuration(&draft.wallpaper, group_id.as_deref())?;
        self.prepare_preview(
            configuration,
            Some((draft_id, draft_revision)),
            lease_id,
            slot,
            target,
        )
    }

    /// Legacy local controls enter the same owner; they never create an iframe or another renderer.
    pub(super) fn open_preview(
        &mut self,
        target: &EventLoopWindowTarget<()>,
        candidate: &WallpaperCandidate,
    ) -> Result<(), String> {
        let configuration = candidate.normalized()?;
        self.open_settings(target);
        if self.settings.is_none() {
            return Err("无法打开桌面设置".into());
        }
        let slot = self
            .wallpaper_library
            .reserve()
            .map_err(|error| error.to_string())?;
        let lease = new_lease_id()?;
        self.prepare_preview(configuration, None, lease, slot, target)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn prepare_preview(
        &mut self,
        mut configuration: config::WallpaperConfig,
        draft: Option<(String, u64)>,
        lease_id: String,
        slot: crate::wallpaper::service::Slot,
        target: &EventLoopWindowTarget<()>,
    ) -> JobResult<serde_json::Value> {
        validate_configured_presentation(&configuration).map_err(JobError::invalid_input)?;
        self.validate_preview_audio(&configuration)
            .map_err(|error| JobError::new("audio_busy", error))?;
        if !policy::preview_pause_reasons(
            &configuration,
            self.policy.session_unavailable,
            self.policy.display_off,
            self.wallpaper_power,
        )
        .is_empty()
        {
            return Err(JobError::new(
                "preview_paused",
                "当前电源或会话状态暂停预览",
            ));
        }
        let monitor = preview_monitor()?;
        let configured_fps = configuration.presentation().fps;
        let selection = match &configuration.main().selection {
            Selection::Package { .. } | Selection::Playlist { .. } => {
                Some(configuration.main().selection.clone())
            }
            _ => {
                configuration.main_mut().presentation.fps = configured_fps.min(15);
                None
            }
        };
        self.wallpaper_audio_dispatch.invalidate();
        self.wallpaper_generation += 1;
        let id = self.wallpaper_generation;
        let cancel = Arc::new(AtomicBool::new(false));
        let media = selection.is_some();
        if let Some(selection) = selection {
            let proxy = self.proxy.clone();
            self.wallpaper_library.resolve_desktop_selection(
                selection,
                ImageTarget {
                    width: monitor.width as u32,
                    height: monitor.height as u32,
                    purpose: ImagePurpose::Preview,
                    fit: if matches!(
                        configuration.presentation().fit,
                        crate::wallpaper::config::Fit::Contain
                    ) {
                        ImageFit::Contain
                    } else {
                        ImageFit::Cover
                    },
                },
                crate::wallpaper::selection_plan::SelectionOptions {
                    properties: configuration.main().properties.clone(),
                    composition_fit: Some(configuration.presentation().fit),
                    ..Default::default()
                },
                Arc::clone(&cancel),
                slot,
                move |result| {
                    let _ = proxy.send_event(UserEvent::MediaPreviewSelection(
                        id,
                        result.map(Box::new).map_err(|failure| failure.error),
                    ));
                },
            )?;
        } else {
            drop(slot);
        }
        let previous = self.preview.take();
        let (surface, frame) = if let Some(mut previous) = previous {
            previous.cancel.store(true, Ordering::Release);
            if let Some(frame) = &mut previous.frame {
                frame.reveal = None;
            }
            (previous.surface.take(), previous.frame.take())
        } else {
            (None, None)
        };
        self.preview = Some(PreviewOwner {
            id,
            owner: self.settings_generation,
            draft,
            lease_id: lease_id.clone(),
            lease_until: Instant::now() + PREVIEW_LEASE,
            cancel,
            configuration,
            reference: None,
            configured_fps,
            monitor,
            prepared: (!media).then_some(PreviewContent::Builtin(None)),
            surface,
            frame,
            error: None,
            heartbeat_at: Instant::now(),
        });
        if let Err(error) = self.stage_preview(target) {
            self.fail_preview(error.to_string());
            return Err(JobError::new("preview_failed", error.to_string()));
        }
        self.send_settings_status(None, None);
        Ok(
            serde_json::json!({"leaseId":lease_id,"generation":id,"expiresInMs":15000,"kind":if media {"media"} else {"builtin"}}),
        )
    }

    pub(super) fn close_preview_owner(&mut self) -> bool {
        let Some(mut preview) = self.preview.take() else {
            return false;
        };
        preview.cancel.store(true, Ordering::Release);
        if let Some(surface) = preview.surface.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        if let Some(mut frame) = preview.frame.take() {
            frame.retire();
            self.wallpaper_handoff_retiring.push(frame);
        }
        self.poll_wallpaper_retirements();
        true
    }

    fn stage_preview(&mut self, target: &EventLoopWindowTarget<()>) -> Result<()> {
        // A successor cannot overlap an old controller whose Close has not completed.
        self.poll_wallpaper_retirements();
        if !self.wallpaper_retiring.is_empty()
            || self
                .wallpaper_handoff_retiring
                .iter()
                .any(|frame| frame.window.is_some())
        {
            return Ok(());
        }
        let Some(preview) = self
            .preview
            .as_ref()
            .filter(|preview| preview.prepared.is_some())
        else {
            return Ok(());
        };
        if preview.error.is_some() {
            return Ok(());
        }
        if let Some(surface) = &preview.surface {
            if surface.binding.generation() == preview.id {
                return Ok(());
            }
            if preview
                .frame
                .as_ref()
                .is_some_and(|frame| frame.window.is_some())
                || !surface.first_frame_ready()
            {
                let preview = self.preview.as_mut().expect("preview");
                if let Some(frame) = &mut preview.frame {
                    frame.reveal = None;
                }
                if let Some(surface) = preview.surface.take() {
                    self.wallpaper_retiring
                        .push(RetiringWallpaper::new(surface));
                }
                return Ok(());
            }
            if preview.frame.is_none() {
                let owner = self
                    .settings
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("预览所属设置已关闭"))?
                    .window
                    .hwnd() as HWND;
                let (frame, script) = Handoff::begin(surface, Some(owner))?;
                surface.eval(&script);
                self.preview.as_mut().expect("preview").frame = Some(frame);
            }
            return Ok(());
        }
        if preview
            .frame
            .as_ref()
            .is_some_and(|frame| !frame.hold.source_has_closed() || frame.window.is_none())
        {
            return Ok(());
        }
        if let Some((id, revision)) = &preview
            .draft
            .as_ref()
            .filter(|(id, _)| !id.starts_with("work-"))
        {
            let draft = self
                .settings_drafts
                .get(preview.owner, id, *revision)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            draft
                .check_apply(draft.base_revision, &self.config)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        }
        let owner = self
            .settings
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("预览所属设置已关闭"))?
            .window
            .hwnd() as HWND;
        let builtin = match preview.prepared.as_ref() {
            Some(PreviewContent::Builtin(state)) => state.clone(),
            _ => None,
        };
        let composition = if matches!(preview.prepared, Some(PreviewContent::Composition(_))) {
            match self.preview.as_mut().expect("preview").prepared.take() {
                Some(PreviewContent::Composition(plan)) => Some(plan),
                _ => None,
            }
        } else {
            None
        };
        let preview = self.preview.as_ref().expect("preview");
        let mut surface = create_resolved_presentation(
            target,
            self.proxy.clone(),
            preview.id,
            preview
                .draft
                .as_ref()
                .map_or(self.config.revision, |(_, revision)| *revision),
            preview.configuration.clone(),
            builtin,
            composition,
            preview.monitor.clone(),
            PresentationWindow::Preview { owner },
        )?;
        if surface.runtime_builtin.is_none() || surface.configuration.follows_hertz() {
            surface.runtime_builtin = crate::wallpaper::follow::resolve(
                &surface.configuration,
                self.wallpaper_last.as_ref(),
            );
        }
        surface.runtime_reference = preview.reference.clone();
        let preview = self.preview.as_mut().expect("preview owner");
        if let Some(PreviewContent::Media(media)) = preview.prepared.take() {
            if let Err(error) = surface.session.admit_media(
                preview.id,
                media,
                crate::wallpaper::budget::global(),
                &surface._media_access,
                format!("preview-{}", preview.lease_id),
            ) {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
                return Err(anyhow::anyhow!(error.to_string()));
            }
        }
        if let Some(frame) = &preview.frame {
            if let Some(window) = &frame.window {
                if let Err(error) = window.raise() {
                    self.wallpaper_retiring
                        .push(RetiringWallpaper::new(surface));
                    return Err(error);
                }
            }
        }
        preview.surface = Some(surface);
        preview.heartbeat_at = Instant::now();
        Ok(())
    }

    pub(super) fn finish_preview_selection(
        &mut self,
        id: u64,
        result: JobResult<crate::wallpaper::selection_plan::ResolvedPlan>,
        target: &EventLoopWindowTarget<()>,
    ) {
        let Some(preview) = self.preview.as_mut().filter(|preview| preview.id == id) else {
            return;
        };
        let result = result.map(|plan| {
            preview.reference = Some(plan.reference);
            plan.content
        });
        match result {
            Ok(crate::wallpaper::selection_plan::ResolvedSelection::Media(media)) => {
                preview.prepared = Some(PreviewContent::Media(media))
            }
            Ok(crate::wallpaper::selection_plan::ResolvedSelection::Builtin(builtin)) => {
                preview.configuration.main_mut().presentation.fps = preview.configured_fps.min(15);
                preview.prepared = Some(PreviewContent::Builtin(Some(builtin)));
            }
            Ok(crate::wallpaper::selection_plan::ResolvedSelection::Composition(plan)) => {
                preview.configuration.main_mut().presentation.fps = preview.configured_fps.min(15);
                preview.prepared = Some(PreviewContent::Composition(plan));
            }
            Err(error) => {
                self.fail_preview(format!("预览未能呈现：{error}"));
                return;
            }
        }
        self.tick_preview(target);
    }

    fn fail_preview(&mut self, message: String) {
        if let Some(preview) = self.preview.as_mut() {
            let retained = preview
                .frame
                .as_ref()
                .is_some_and(|frame| frame.window.is_some());
            let old_live = preview
                .surface
                .as_ref()
                .is_some_and(|surface| surface.binding.generation() != preview.id);
            if retained || old_live {
                preview.error = Some(message.clone());
                preview.prepared = None;
                if retained {
                    if let Some(frame) = &mut preview.frame {
                        frame.reveal = None;
                    }
                    if let Some(surface) = preview.surface.take() {
                        self.wallpaper_retiring
                            .push(RetiringWallpaper::new(surface));
                    }
                }
                self.send_settings_status(Some(&message), None);
                return;
            }
        }
        self.close_preview();
        self.send_settings_status(Some(&message), None);
    }

    pub(super) fn handle_preview_capture(&mut self, generation: u64, message: &str) -> bool {
        let Some(frame) = self
            .preview
            .as_mut()
            .and_then(|preview| preview.frame.as_mut())
            .filter(|frame| frame.hold.request.generation == generation)
        else {
            return false;
        };
        let Some(result) = frame.accept(message) else {
            return true;
        };
        if let Err(error) = result {
            self.fail_preview_capture(error.to_string());
        } else if let Some(surface) = self
            .preview
            .as_mut()
            .and_then(|preview| preview.surface.take())
        {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        true
    }

    fn fail_preview_capture(&mut self, message: String) {
        if let Some(preview) = &mut self.preview {
            if let Some(mut frame) = preview.frame.take() {
                frame.retire();
                self.wallpaper_handoff_retiring.push(frame);
            }
        }
        self.fail_preview(message);
    }

    pub(super) fn handle_preview_page(&mut self, generation: u64, event: &str) -> bool {
        let Some(preview) = self.preview.as_mut().filter(|preview| {
            preview
                .surface
                .as_ref()
                .is_some_and(|surface| surface.binding.generation() == generation)
        }) else {
            return false;
        };
        if preview.lease_until <= Instant::now() || preview.owner != self.settings_generation {
            self.close_preview();
            return true;
        }
        let failed = event.starts_with("wallpaper_media_failed ")
            || event.starts_with("wallpaper_gl_failed ")
            || event == "wallpaper_mount_failed"
            || parse_wallpaper_heartbeat(event).is_some_and(|(_, _, _, lost)| lost);
        if failed
            && generation != preview.id
            && preview
                .frame
                .as_ref()
                .is_some_and(|frame| frame.window.is_some())
        {
            // A superseded candidate cannot cancel the newer draft. Its old frame
            // is already retained, so only this obsolete renderer must exit.
            if let Some(surface) = preview.surface.take() {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
            }
            return true;
        }
        let Some(surface) = preview.surface.as_mut() else {
            return true;
        };
        if let Some(clock) = parse_page_clock(event) {
            surface.page_clock = Some(clock);
            return true;
        }
        if let Some((_, _, mounted, lost)) = parse_wallpaper_heartbeat(event) {
            if mounted && !lost {
                preview.heartbeat_at = Instant::now();
            }
            if lost {
                self.fail_preview("预览图形上下文已丢失，请重新预览".into());
            }
            return true;
        }
        if event.starts_with("wallpaper_media_failed ")
            || event.starts_with("wallpaper_gl_failed ")
            || event == "wallpaper_mount_failed"
        {
            self.fail_preview(format!(
                "预览加载失败：{}",
                event.chars().take(256).collect::<String>()
            ));
            return true;
        }
        match surface.binding.parse(event) {
            Some(PageEvent::Revealed) => {
                if preview.id == generation
                    && preview.frame.as_ref().is_some_and(|frame| {
                        frame
                            .reveal
                            .is_some_and(|(expected, _)| expected == generation)
                    })
                {
                    if let Some(mut frame) = preview.frame.take() {
                        frame.retire();
                        self.wallpaper_handoff_retiring.push(frame);
                    }
                }
                return true;
            }
            Some(PageEvent::Handshake) => {
                if surface.session.page_handshake(generation) {
                    if let Some(snapshot) = self.wallpaper_last.as_ref() {
                        surface.apply_feed(snapshot);
                    }
                    surface.load_media_page();
                }
            }
            Some(PageEvent::FirstFrame(kind)) => {
                if kind == surface.media_frame_kind() {
                    surface.session.frame_submitted(generation, kind);
                }
            }
            Some(PageEvent::MediaPaused(token)) => {
                surface
                    .session
                    .confirm_media_pause(generation, token, Instant::now());
            }
            _ => {}
        }
        // Recording one receipt does not itself prove all four readiness facts.
        // Reveal only on the actual Ready -> Running transition, regardless of receipt order.
        if surface.session.start_presentation(Instant::now()) {
            if let Err(error) = native::wallpaper_opacity(surface.hwnd(), 255) {
                self.fail_preview(error.to_string());
            } else {
                if let Some(frame) = preview.frame.as_mut().filter(|_| preview.id == generation) {
                    frame.reveal = Some((generation, Instant::now()));
                }
                surface.eval("window.hertzWallpaper && window.hertzWallpaper.reveal();");
                self.send_settings_status(None, None);
            }
        }
        true
    }

    pub(super) fn tick_preview(&mut self, target: &EventLoopWindowTarget<()>) {
        let Some(preview) = self.preview.as_ref() else {
            return;
        };
        if preview.cancel.load(Ordering::Acquire)
            || preview.lease_until <= Instant::now()
            || preview.owner != self.settings_generation
            || self.settings.is_none()
            || !policy::preview_pause_reasons(
                &preview.configuration,
                self.policy.session_unavailable,
                self.policy.display_off,
                self.wallpaper_power,
            )
            .is_empty()
        {
            self.close_preview();
            return;
        }
        if preview
            .frame
            .as_ref()
            .is_some_and(|frame| frame.hold.expired())
        {
            self.fail_preview_capture("预览静态采集超时，保留原画面".into());
            return;
        }
        if preview
            .frame
            .as_ref()
            .is_some_and(|frame| frame.window.as_ref().is_some_and(|window| !window.alive()))
        {
            self.fail_preview_capture("预览静态窗口已关闭，请重新预览".into());
            return;
        }
        if preview.frame.as_ref().is_some_and(|frame| {
            frame
                .reveal
                .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(3))
        }) {
            self.fail_preview("新预览未确认显示，继续保留静态画面".into());
            return;
        }
        if preview.error.is_some() {
            return;
        }
        if preview.configuration.follows_hertz() && preview.prepared.is_none() {
            let desired = crate::wallpaper::follow::resolve(
                &preview.configuration,
                self.wallpaper_last.as_ref(),
            );
            if preview
                .surface
                .as_ref()
                .is_some_and(|surface| surface.runtime_builtin != desired)
            {
                self.wallpaper_generation += 1;
                let preview = self.preview.as_mut().expect("preview");
                preview.id = self.wallpaper_generation;
                if let Some(frame) = &mut preview.frame {
                    frame.reveal = None;
                }
                preview.prepared = Some(PreviewContent::Builtin(None));
            }
        }
        let preview = self.preview.as_ref().expect("preview");
        if preview.prepared.is_some() {
            if let Err(error) = self.stage_preview(target) {
                self.fail_preview(format!("预览未能呈现：{error}"));
            }
            return;
        }
        if let Some(surface) = preview.surface.as_ref() {
            let size = surface.window.inner_size();
            if size.width != preview.monitor.width as u32
                || size.height != preview.monitor.height as u32
            {
                self.fail_preview("预览窗口尺寸已变化，请重新预览".into());
            } else if (!surface.first_frame_ready()
                && surface.created_at.elapsed() > HEARTBEAT_STALE)
                || (surface.first_frame_ready() && preview.heartbeat_at.elapsed() > HEARTBEAT_STALE)
            {
                self.fail_preview("预览未在期限内提交首帧或心跳".into());
            }
        } else if let Err(error) = self.stage_preview(target) {
            self.fail_preview(format!("预览未能呈现：{error}"));
        }
    }

    pub(super) fn preview_active(&self) -> bool {
        self.preview.is_some()
    }
    pub(super) fn preview_lease(&self) -> Option<&str> {
        self.preview
            .as_ref()
            .map(|preview| preview.lease_id.as_str())
    }
    pub(super) fn preview_surface(&self) -> Option<&WallpaperSurface> {
        self.preview.as_ref()?.surface.as_ref()
    }
    pub(super) fn renew_preview(&mut self, lease: Option<&str>) {
        if let Some(preview) = self.preview.as_mut().filter(|preview| {
            Some(preview.lease_id.as_str()) == lease && preview.lease_until > Instant::now()
        }) {
            preview.lease_until = Instant::now() + PREVIEW_LEASE;
            self.send_settings_status(None, None);
        } else {
            self.send_settings_status(Some("预览租约已过期或不匹配"), None);
        }
    }
    pub(super) fn preview_diagnostics(&self) -> serde_json::Value {
        let Some(preview) = self.preview.as_ref() else {
            return serde_json::Value::Null;
        };
        let surface = preview.surface.as_ref();
        serde_json::json!({"kind":if preview.configuration.builtin().is_some() {"builtin"} else {"media"},
            "preparing":surface.is_none(),"leaseId":preview.lease_id,"generation":preview.id,
            "firstFrameReady":surface.is_some_and(|surface| surface.binding.generation() == preview.id && surface.first_frame_ready()),"binding":surface.map(|surface| &surface.binding),
            "handoff":preview.frame.as_ref().map(Handoff::diagnostics),"error":preview.error,
            "runtimeBuiltin":preview.frame.as_ref().and_then(|frame| frame.runtime_builtin.as_ref()).or_else(|| surface.and_then(|surface| surface.runtime_builtin.as_ref())),
            "mediaAllocation":surface.and_then(|surface| surface.session.media_allocation()),
            "glAllocation":surface.and_then(|surface| surface.session.gl()).and_then(|gl| gl.snapshot()),
            "glLimits":surface.and_then(|surface| surface.session.gl()).map(|gl| &gl.limits),
            "width":preview.monitor.width,"height":preview.monitor.height,"selection":preview.configuration.main().selection,
            "configuredFps":preview.configured_fps,"effectiveFps":preview.configuration.presentation().fps})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::config::{AudioInput, DisplaySelection, Fit};
    use serde_json::json;

    fn multiple_groups(mode: LayoutMode) -> config::WallpaperConfig {
        let mut configuration = config::WallpaperConfig {
            enabled: true,
            audio_input: AudioInput::None,
            pause_on_fullscreen: false,
            pause_on_maximized: true,
            ..Default::default()
        };
        let mut secondary = configuration.main().clone();
        secondary.id = "secondary".into();
        secondary.mode = mode;
        secondary.displays = vec![
            DisplaySelection::Fixed {
                display_id: "monitor-b".into(),
            },
            DisplaySelection::Fixed {
                display_id: "monitor-c".into(),
            },
        ];
        secondary.selection = Selection::Package {
            work_key: "secondary-work".into(),
            package_hash: "b".repeat(64),
        };
        secondary.presentation.fps = 60;
        secondary.presentation.fit = Fit::Contain;
        secondary.presentation.brightness = 0.5;
        secondary.properties.insert("accent".into(), json!("blue"));
        let mut last = configuration.main().clone();
        last.id = "last".into();
        last.displays = vec![DisplaySelection::Fixed {
            display_id: "monitor-d".into(),
        }];
        configuration.groups.extend([secondary, last]);
        configuration
    }

    #[test]
    fn preview_projects_the_named_group_without_changing_the_complete_intent() {
        for mode in [LayoutMode::Mirror, LayoutMode::Span] {
            let configuration = multiple_groups(mode);
            let original = serde_json::to_value(&configuration).unwrap();
            let projected = preview_configuration(&configuration, Some("secondary")).unwrap();
            assert_eq!(projected.groups.len(), 1);
            assert_eq!(projected.main().id, "secondary");
            assert_eq!(projected.main().mode, LayoutMode::Single);
            assert_eq!(
                projected.main().displays,
                vec![DisplaySelection::Fixed {
                    display_id: "monitor-b".into()
                }]
            );
            let actual = serde_json::to_value(&projected).unwrap();
            for field in ["id", "selection", "presentation", "properties"] {
                assert_eq!(actual["groups"][0][field], original["groups"][1][field]);
            }
            for (field, value) in original.as_object().unwrap() {
                if field != "groups" {
                    assert_eq!(&actual[field], value);
                }
            }
            assert_eq!(serde_json::to_value(&configuration).unwrap(), original);
        }
    }

    #[test]
    fn omitted_group_uses_the_first_group_and_missing_group_never_falls_back() {
        let configuration = multiple_groups(LayoutMode::Mirror);
        let projected = preview_configuration(&configuration, None).unwrap();
        assert_eq!(projected.groups.len(), 1);
        assert_eq!(
            serde_json::to_value(projected.main()).unwrap(),
            serde_json::to_value(configuration.main()).unwrap()
        );
        assert_eq!(
            preview_configuration(&configuration, Some("missing"))
                .unwrap_err()
                .code,
            "group_not_found"
        );
        let mut no_groups = configuration.clone();
        no_groups.groups.clear();
        assert_eq!(
            preview_configuration(&no_groups, None).unwrap_err().code,
            "group_not_found"
        );
        let mut no_displays = configuration.clone();
        no_displays.groups[1].displays.clear();
        assert_eq!(
            preview_configuration(&no_displays, Some("secondary"))
                .unwrap_err()
                .code,
            "invalid_input"
        );
    }
}
