// SPDX-License-Identifier: MIT
//! Single-display playlist glue. The stored config remains a Playlist selection.
use super::*;
use crate::wallpaper::{
    config::Selection,
    jobs::JobError,
    playlist::{Playlist, Runner, Switch},
};

impl App {
    pub(super) fn install_playlist_snapshot(&mut self, playlist: Option<Playlist>) -> Option<u64> {
        let playlist = playlist?;
        let mut runner = Runner::new(
            playlist,
            self.wallpaper_generation
                .wrapping_mul(0x9e3779b97f4a7c15)
                .max(1),
        )
        .ok()?;
        let first = runner.initial()?;
        self.desktop.playlist = Some(runner);
        Some(first.token)
    }

    pub(super) fn playlist_presented(&mut self, generation: u64) {
        if self.is_mirror_target() {
            self.mirror_presented(generation);
            return;
        }
        let desktop = &mut *self.desktop;
        let Some(surface) = desktop
            .surface
            .as_ref()
            .filter(|surface| surface.binding.generation() == generation && !surface.static_poster)
        else {
            return;
        };
        if let (Some(token), Some(runner)) = (surface.playlist_token, desktop.playlist.as_mut()) {
            if runner.pending_fixed() == surface.runtime_reference.as_ref() {
                runner.presented(token);
            }
        }
    }

    fn start_playlist_switch(&mut self, switch: Switch) -> Result<(), JobError> {
        let token = switch.token;
        self.desktop.failed_revision = None;
        self.desktop.apply_error = None;
        let result = self.wallpaper_library.reserve().and_then(|slot| {
            self.begin_selection_switch(self.desktop.configuration.clone(), slot, Some(switch))
        });
        if let Err(error) = &result {
            if error.code == "budget_busy" {
                return result;
            }
            if let Some(runner) = self.desktop.playlist.as_mut() {
                runner.fail(token);
            }
            self.desktop.failed_revision = Some(self.desktop.desired_revision);
            self.desktop.apply_error = Some(error.to_string());
        }
        result
    }

    pub(super) fn playlist_next(
        &mut self,
        playlist_id: &str,
        group_id: Option<&str>,
        retry: bool,
    ) -> Result<serde_json::Value, JobError> {
        let mirror_ids: Vec<_> = self.config.wallpaper.groups.iter().filter(|group| {
            group.mode == crate::wallpaper::config::LayoutMode::Mirror
                && group_id.is_none_or(|id| group.id == id)
                && matches!(&group.selection, Selection::Playlist { playlist_id: selected } if selected == playlist_id)
        }).map(|group| group.id.clone()).collect();
        let matching_groups = self.config.wallpaper.groups.iter().filter(|group| {
            group_id.is_none_or(|id| group.id == id)
                && matches!(&group.selection, Selection::Playlist { playlist_id: selected } if selected == playlist_id)
        }).count();
        if mirror_ids.len() == 1 && matching_groups == 1 {
            let mut result = self.mirror_next(&mirror_ids[0], retry)?;
            result["playlistId"] = playlist_id.into();
            return Ok(result);
        }
        let keys: Vec<_> = self.desktop.runtimes.iter().filter(|(_, desktop)| !desktop.closing && group_id.is_none_or(|id| desktop.configuration.main().id == id) && matches!(&desktop.configuration.main().selection, Selection::Playlist { playlist_id: selected } if selected == playlist_id)).map(|(key, _)| key.clone()).collect();
        if keys.len() != 1 {
            return Err(JobError::new(
                if keys.is_empty() {
                    "playlist_not_active"
                } else {
                    "ambiguous_group"
                },
                "请选择唯一应用此列表的显示组",
            ));
        }
        self.with_desktop(&keys[0], |app| app.playlist_next_target(playlist_id, retry))
            .expect("routed playlist")
    }

    fn playlist_next_target(
        &mut self,
        playlist_id: &str,
        retry: bool,
    ) -> Result<serde_json::Value, JobError> {
        if !matches!(&self.desktop.configuration.main().selection, Selection::Playlist { playlist_id: selected } if selected == playlist_id)
        {
            return Err(JobError::new("playlist_not_active", "请先应用此轮播列表"));
        }
        if self.wallpaper_apply.is_some()
            || self
                .desktop
                .runtimes
                .values()
                .any(|runtime| runtime.selection.is_some())
            || self.desktop.candidate.is_some()
            || self.desktop.prepared.is_some()
        {
            return Err(JobError::new("budget_busy", "已有作品正在切换"));
        }
        let runner = self.desktop.playlist.as_mut().ok_or_else(|| {
            JobError::new("playlist_not_ready", "轮播尚未准备完成，请重新加载壁纸")
        })?;
        let switch = if retry {
            runner.retry()?
        } else {
            runner.next()?
        };
        let index = switch.index;
        self.start_playlist_switch(switch)?;
        Ok(serde_json::json!({"playlistId":playlist_id,"pendingIndex":index}))
    }

    pub(super) fn tick_wallpaper_playlist(&mut self) {
        if self.is_mirror_target() {
            return;
        }
        let id = match &self.desktop.configuration.main().selection {
            Selection::Playlist { playlist_id } => playlist_id,
            _ => {
                self.desktop.playlist = None;
                self.desktop.playlist_reload_needed = false;
                return;
            }
        };
        if self
            .desktop
            .playlist
            .as_ref()
            .is_some_and(|runner| &runner.playlist().playlist_id != id)
        {
            self.desktop.playlist = None;
        }
        if self.desktop.playlist_reload_needed {
            if self.wallpaper_target_running(&self.desktop.configuration)
                && self.wallpaper_render_allowed()
                && self.desktop.selection.is_none()
                && self.desktop.candidate.is_none()
                && self.desktop.prepared.is_none()
            {
                let result = self.wallpaper_library.reserve().and_then(|slot| {
                    self.begin_selection_switch(self.desktop.configuration.clone(), slot, None)
                });
                if result.is_ok() {
                    self.desktop.playlist_reload_needed = false;
                }
            }
            return;
        }
        let failed = self.desktop.failed_revision == Some(self.desktop.desired_revision);
        if !failed
            && self.wallpaper_target_running(&self.desktop.configuration)
            && self.wallpaper_render_allowed()
            && self.desktop.selection.is_none()
            && self.desktop.candidate.is_none()
            && self.desktop.prepared.is_none()
            && self
                .desktop
                .handoff
                .as_ref()
                .is_none_or(|handoff| handoff.reveal.is_none())
        {
            if let Some(switch) = self
                .desktop
                .playlist
                .as_ref()
                .and_then(|r| r.pending())
                .cloned()
            {
                // Policy teardown can remove a candidate before its first frame.
                // Requalify the same pending item and keep its acknowledgement token.
                let _ = self.start_playlist_switch(switch);
                return;
            }
        }
        let renderable = self.wallpaper_target_running(&self.desktop.configuration)
            && self.desktop.visible
            && self.wallpaper_render_allowed()
            && self.desktop.handoff.is_none()
            && self.desktop.selection.is_none()
            && self.desktop.candidate.is_none()
            && self.desktop.prepared.is_none()
            && self.desktop.surface.as_ref().is_some_and(|surface| {
                surface.first_frame_ready()
                    && !surface.static_poster
                    && native::wallpaper_alive(surface.hwnd())
            });
        let Some(runner) = self.desktop.playlist.as_mut() else {
            return;
        };
        if failed {
            if let Some(token) = runner.pending().map(|v| v.token) {
                runner.fail(token);
            } else if !runner.is_failed() {
                runner.fail_current();
            }
        }
        if let Some(switch) = runner.tick(Instant::now(), renderable && !failed) {
            let _ = self.start_playlist_switch(switch);
        }
    }

    pub(super) fn playlist_changed(&mut self, playlist_id: &str) {
        if let Some(settings) = &self.settings {
            settings.eval("window.dispatchEvent(new Event('wallpaper-layout-invalidated'));");
        }
        if let Some(transaction) = &self.wallpaper_apply {
            transaction.cancel_for_playlist(playlist_id);
        }
        self.for_each_desktop(|app| app.playlist_changed_target(playlist_id));
        let ids: Vec<_> = self
            .desktop
            .mirrors
            .iter()
            .filter(|(_, group)| {
                group
                    .playback
                    .playlist()
                    .is_some_and(|playlist| playlist.playlist_id == playlist_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.desktop.mirrors.remove(&id);
            for runtime in self
                .desktop
                .runtimes
                .values_mut()
                .filter(|runtime| runtime.configuration.main().id == id)
            {
                runtime.mirror_ticket = None;
                runtime.mirror_released = false;
                runtime.mirror_presented = None;
            }
        }
    }

    fn playlist_changed_target(&mut self, playlist_id: &str) {
        if self
            .desktop
            .selection
            .as_ref()
            .is_some_and(|task| task.selects_playlist(playlist_id))
        {
            self.desktop.playlist_epoch = self.desktop.playlist_epoch.wrapping_add(1);
        }
        if matches!(&self.desktop.configuration.main().selection, Selection::Playlist { playlist_id: selected } if selected == playlist_id)
        {
            self.cancel_wallpaper_transition();
            self.desktop.playlist = None;
            self.desktop.failed_revision = None;
            self.desktop.playlist_reload_needed = true;
        }
    }
}

pub(super) fn status(desktop: &wallpaper_runtime::DesktopRuntime) -> serde_json::Value {
    desktop.playlist.as_ref().map_or(serde_json::Value::Null, |runner| {
            serde_json::json!({"playlistId":runner.playlist().playlist_id,"playlistRevision":runner.playlist().revision,
                "title":runner.playlist().title,"mode":runner.playlist().mode,"intervalSeconds":runner.playlist().interval_seconds,
                "currentIndex":runner.current_index(),"pendingIndex":runner.pending().map(|v| v.index),
                "itemCount":runner.playlist().items.len(),"failed":runner.is_failed(),"current":runner.current()})
        })
}
