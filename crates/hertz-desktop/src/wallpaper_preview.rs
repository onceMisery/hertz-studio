// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Settings-owned media previews use the same fixed plan, resource ledger and physical exit
//! barrier as desktop candidates, with a separate native controller and expiring lease.
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

pub(super) struct MediaPreview {
    id: u64,
    owner: u64,
    draft_id: String,
    draft_revision: u64,
    pub(super) lease_id: String,
    pub(super) lease_until: Instant,
    cancel: Arc<AtomicBool>,
    configuration: config::WallpaperConfig,
    monitor: native::WallpaperMonitor,
    pub(super) surface: Option<WallpaperSurface>,
    heartbeat_at: Instant,
}

impl App {
    pub(super) fn media_preview_request(&self, request: &api::Request, owner: u64) -> bool {
        let reference = match request.typed() {
            Ok(api::Command::PreviewAcquire {
                draft_id,
                draft_revision,
            })
            | Ok(api::Command::PreviewUpdate {
                draft_id,
                draft_revision,
                ..
            }) => (draft_id, draft_revision),
            _ => return false,
        };
        self.settings_drafts
            .get(owner, &reference.0, reference.1)
            .is_ok_and(|draft| {
                matches!(draft.wallpaper.main().selection, Selection::Package { .. })
            })
    }

    pub(super) fn begin_media_preview(
        &mut self,
        request: &api::Request,
        owner: u64,
        slot: crate::wallpaper::service::Slot,
    ) -> JobResult<serde_json::Value> {
        let (draft_id, draft_revision, lease_id) = match request.typed()? {
            api::Command::PreviewAcquire {
                draft_id,
                draft_revision,
            } => {
                if self.preview_active() {
                    return Err(JobError::new("preview_busy", "请先释放当前预览"));
                }
                (
                    draft_id,
                    draft_revision,
                    new_lease_id().map_err(JobError::invalid_input)?,
                )
            }
            api::Command::PreviewUpdate {
                draft_id,
                draft_revision,
                lease_id,
            } => {
                self.check_preview_owner(owner, &lease_id)?;
                (draft_id, draft_revision, lease_id)
            }
            _ => return Err(JobError::invalid_input("需要预览命令")),
        };
        let draft = self
            .settings_drafts
            .get(owner, &draft_id, draft_revision)?
            .clone();
        draft.check_apply(draft.base_revision, &self.config)?;
        validate_configured_presentation(&draft.wallpaper).map_err(JobError::invalid_input)?;
        if !policy::preview_pause_reasons(
            &draft.wallpaper,
            self.policy.session_unavailable,
            self.policy.display_off,
            self.wallpaper_power,
        )
        .is_empty()
        {
            return Err(JobError::new(
                "preview_paused",
                "当前电源或会话状态暂停媒体预览",
            ));
        }
        let Selection::Package {
            work_key,
            package_hash,
        } = &draft.wallpaper.main().selection
        else {
            return Err(JobError::invalid_input("需要固定作品版本"));
        };
        // A fixed physical client size gives the output ledger an authoritative native target.
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
        let target = ImageTarget {
            width: width as u32,
            height: height as u32,
            purpose: ImagePurpose::Preview,
            fit: if matches!(
                draft.wallpaper.presentation().fit,
                crate::wallpaper::config::Fit::Contain
            ) {
                ImageFit::Contain
            } else {
                ImageFit::Cover
            },
        };
        let selection = crate::wallpaper::selection_plan::Request {
            work_key: work_key.clone(),
            package_hash: package_hash.clone(),
            target,
        };
        self.close_preview();
        self.wallpaper_generation += 1;
        let id = self.wallpaper_generation;
        let cancel = Arc::new(AtomicBool::new(false));
        let proxy = self.proxy.clone();
        self.wallpaper_library.resolve_selection_reserved(
            selection,
            Arc::clone(&cancel),
            slot,
            move |result| {
                let _ =
                    proxy.send_event(UserEvent::MediaPreviewSelection(id, result.map(Box::new)));
            },
        )?;
        self.media_preview = Some(MediaPreview {
            id,
            owner,
            draft_id,
            draft_revision,
            lease_id: lease_id.clone(),
            lease_until: Instant::now() + PREVIEW_LEASE,
            cancel,
            configuration: draft.wallpaper,
            monitor,
            surface: None,
            heartbeat_at: Instant::now(),
        });
        self.send_settings_status(None, None);
        Ok(
            serde_json::json!({"leaseId":lease_id,"generation":id,"expiresInMs":15000,"kind":"media"}),
        )
    }

    pub(super) fn close_media_preview(&mut self) -> bool {
        let Some(mut preview) = self.media_preview.take() else {
            return false;
        };
        preview.cancel.store(true, Ordering::Release);
        if let Some(surface) = preview.surface.take() {
            self.wallpaper_retiring
                .push(RetiringWallpaper::new(surface));
        }
        self.poll_wallpaper_retirements();
        true
    }

    pub(super) fn finish_media_preview(
        &mut self,
        id: u64,
        result: JobResult<ResolvedMedia>,
        target: &EventLoopWindowTarget<UserEvent>,
    ) {
        let Some(preview) = self
            .media_preview
            .as_ref()
            .filter(|preview| preview.id == id)
        else {
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
        let result = (|| -> Result<WallpaperSurface> {
            let draft = self
                .settings_drafts
                .get(preview.owner, &preview.draft_id, preview.draft_revision)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            draft
                .check_apply(draft.base_revision, &self.config)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let media = result.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let owner = self
                .settings
                .as_ref()
                .expect("settings owner")
                .window
                .hwnd() as HWND;
            let mut surface = create_presentation(
                target,
                self.proxy.clone(),
                id,
                preview.draft_revision,
                preview.configuration.clone(),
                preview.monitor.clone(),
                PresentationWindow::Preview { owner },
            )?;
            if let Err(error) = surface.session.admit_media(
                id,
                media,
                crate::wallpaper::budget::global(),
                &surface._media_access,
                format!("preview-{}", preview.lease_id),
            ) {
                self.wallpaper_retiring
                    .push(RetiringWallpaper::new(surface));
                return Err(anyhow::anyhow!(error.to_string()));
            }
            Ok(surface)
        })();
        match result {
            Ok(surface) => {
                let preview = self.media_preview.as_mut().expect("preview owner");
                preview.surface = Some(surface);
                preview.heartbeat_at = Instant::now();
            }
            Err(error) => self.fail_media_preview(format!("媒体预览未能呈现：{error}")),
        }
    }

    fn fail_media_preview(&mut self, message: String) {
        self.close_preview();
        self.send_settings_status(Some(&message), None);
    }

    pub(super) fn handle_media_preview_page(&mut self, generation: u64, event: &str) -> bool {
        let Some(preview) = self
            .media_preview
            .as_mut()
            .filter(|preview| preview.id == generation)
        else {
            return false;
        };
        if preview.lease_until <= Instant::now() || preview.owner != self.settings_generation {
            self.close_preview();
            return true;
        }
        let Some(surface) = preview.surface.as_mut() else {
            return true;
        };
        if let Some(clock) = parse_page_clock(event) {
            surface.page_clock = Some(clock);
            return true;
        }
        if event.starts_with("wallpaper_heartbeat ") {
            preview.heartbeat_at = Instant::now();
            return true;
        }
        if event.starts_with("wallpaper_media_failed ") || event == "wallpaper_mount_failed" {
            self.fail_media_preview(format!(
                "媒体预览加载失败：{}",
                event.chars().take(256).collect::<String>()
            ));
            return true;
        }
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
                    if let Err(error) = native::wallpaper_opacity(surface.hwnd(), 255) {
                        self.fail_media_preview(error.to_string());
                    } else {
                        self.send_settings_status(None, None);
                    }
                }
            }
            _ => {}
        }
        true
    }

    pub(super) fn tick_media_preview(&mut self) {
        let Some(preview) = self.media_preview.as_ref() else {
            return;
        };
        if preview.lease_until <= Instant::now()
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
        if let Some(surface) = preview.surface.as_ref() {
            let size = surface.window.inner_size();
            if size.width != preview.monitor.width as u32
                || size.height != preview.monitor.height as u32
            {
                self.fail_media_preview("预览窗口尺寸已变化，请重新预览".into());
            } else if (!surface.first_frame_ready()
                && surface.created_at.elapsed() > HEARTBEAT_STALE)
                || (surface.first_frame_ready() && preview.heartbeat_at.elapsed() > HEARTBEAT_STALE)
            {
                self.fail_media_preview("媒体预览未在期限内提交首帧或心跳".into());
            }
        }
    }

    pub(super) fn preview_active(&self) -> bool {
        self.preview.is_some() || self.media_preview.is_some()
    }
    pub(super) fn preview_lease(&self) -> Option<&str> {
        self.preview
            .as_ref()
            .map(|preview| preview.lease_id.as_str())
            .or_else(|| {
                self.media_preview
                    .as_ref()
                    .map(|preview| preview.lease_id.as_str())
            })
    }
    pub(super) fn preview_diagnostics(&self) -> serde_json::Value {
        let Some(preview) = self.media_preview.as_ref() else {
            return serde_json::Value::Null;
        };
        let surface = preview.surface.as_ref();
        serde_json::json!({"kind":"media","preparing":surface.is_none(),"leaseId":preview.lease_id,
            "generation":preview.id,"firstFrameReady":surface.is_some_and(WallpaperSurface::first_frame_ready),
            "binding":surface.map(|surface| &surface.binding),"width":preview.monitor.width,"height":preview.monitor.height,
            "selection":preview.configuration.main().selection})
    }
}
