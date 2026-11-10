// SPDX-License-Identifier: MIT
//! One playback owner per mirror group. Controllers and budgets remain per target.
use super::*;
use crate::wallpaper::{
    config::{LayoutMode, Selection},
    group_playback::{GroupPlayback, Member, Source},
    jobs::JobError,
    playlist::{FixedVersion, Playlist, Switch},
    selection_plan::{ResolvedPlan, ResolvedSelection},
};

pub(super) struct MirrorRuntime {
    selection: serde_json::Value,
    pub(super) source_generation: u64,
    pub(super) playback: GroupPlayback,
}

pub(super) fn validate_plan(
    configuration: &config::WallpaperConfig,
    plan: &ResolvedPlan,
) -> std::result::Result<(), JobError> {
    if configuration.main().mode != LayoutMode::Mirror {
        return Ok(());
    }
    let ResolvedSelection::Media(media) = &plan.content else {
        return Err(JobError::new(
            "mirror_not_reconstructable",
            "此场景依赖历史状态，暂不支持镜像；请选择图片或视频作品",
        ));
    };
    if media.input().metadata.container != crate::wallpaper::media::Container::Image
        && configuration.main().displays.len() > 2
    {
        return Err(JobError::new(
            "mirror_decoder_limit",
            "视频镜像最多使用两台显示器，所有呈现共用两个解码名额",
        ));
    }
    Ok(())
}

impl App {
    pub(super) fn is_mirror_target(&self) -> bool {
        self.desktop.configuration.main().mode == LayoutMode::Mirror
    }

    fn mirror_members(&self, group_id: &str) -> Vec<Member> {
        self.desktop
            .runtimes
            .iter()
            .filter_map(|(key, runtime)| {
                if runtime.closing || runtime.configuration.main().id != group_id {
                    return None;
                }
                let global_ready = !self
                    .desktop
                    .recovery
                    .is_terminal(crate::wallpaper::session::FaultDomain::Global);
                let runnable = global_ready
                    && self.wallpaper_target_running(&runtime.configuration)
                    && runtime.configuration.presentation().fps > 0
                    && policy::renderable(&policy::PolicyInputs {
                        enabled: self.wallpaper_target_running(&runtime.configuration),
                        wallpaper: &runtime.configuration,
                        manual_pause: self.wallpaper_hidden,
                        fullscreen: runtime.fullscreen_gate.stable(),
                        maximized: runtime.maximized_gate.stable(),
                        application_rule: runtime.application_gate.stable(),
                        session_unavailable: self.policy.session_unavailable,
                        display_off: self.policy.display_off,
                        display_missing: runtime.monitor_missing,
                        power: self.wallpaper_power,
                        has_surface: true,
                        page_ready: true,
                    });
                Some(Member {
                    key: key.clone(),
                    runnable,
                })
            })
            .collect()
    }

    /// Sources outlive temporary missing targets. Only an actual selection change
    /// resets the source; changing a single controller never resets group time.
    pub(super) fn reconcile_mirror_playback(&mut self, now: Instant) {
        if self.feature_stops.wallpaper {
            self.desktop.mirrors.clear();
            return;
        }
        let groups: Vec<_> = self
            .config
            .wallpaper
            .groups
            .iter()
            .filter(|group| group.mode == LayoutMode::Mirror)
            .cloned()
            .collect();
        self.desktop.mirrors.retain(|id, runtime| {
            groups.iter().any(|group| {
                &group.id == id
                    && runtime.selection == serde_json::to_value(&group.selection).unwrap()
            })
        });
        for group in groups {
            if !self.desktop.mirrors.contains_key(&group.id) {
                if let Selection::Package {
                    work_key,
                    package_hash,
                } = &group.selection
                {
                    let source = Source::Fixed(FixedVersion {
                        work_key: work_key.clone(),
                        package_hash: package_hash.clone(),
                    });
                    if let Ok(mut playback) =
                        GroupPlayback::new(source, self.wallpaper_generation.max(1), now)
                    {
                        playback.initial();
                        self.wallpaper_generation += 1;
                        self.desktop.mirrors.insert(
                            group.id.clone(),
                            MirrorRuntime {
                                selection: serde_json::to_value(&group.selection).unwrap(),
                                source_generation: self.wallpaper_generation,
                                playback,
                            },
                        );
                    }
                }
            }
            let members = self.mirror_members(&group.id);
            let rebuilds: Vec<_> = self
                .desktop
                .runtimes
                .iter()
                .filter(|(_, runtime)| {
                    runtime.configuration.main().id == group.id
                        && runtime.mirror_rebuild
                        && runtime.failed_revision.is_none()
                })
                .map(|(key, _)| key.clone())
                .collect();
            if let Some(runtime) = self.desktop.mirrors.get_mut(&group.id) {
                let _ = runtime.playback.reconcile_members(members, now);
                for key in &rebuilds {
                    runtime.playback.rebuild_member(key);
                }
            }
            for key in rebuilds {
                self.with_desktop(&key, |app| {
                    app.cancel_wallpaper_transition();
                    app.desktop.mirror_rebuild = false;
                    app.desktop.mirror_ticket = None;
                    app.desktop.mirror_released = false;
                    app.desktop.mirror_presented = None;
                });
            }
        }
        self.dispatch_mirror_prepares();
    }

    fn dispatch_mirror_prepares(&mut self) {
        let tickets: Vec<_> = self
            .desktop
            .mirrors
            .values_mut()
            .flat_map(|runtime| runtime.playback.take_prepares())
            .collect();
        for ticket in tickets {
            let key = ticket.key.clone();
            self.with_desktop(&key, |app| {
                // Keep the visible source for the existing bounded handoff. A
                // pending worker remains pinned until its real completion event.
                app.cancel_wallpaper_transition();
                app.wallpaper_generation += 1;
                app.desktop.mirror_clock_token = app.wallpaper_generation;
                app.desktop.mirror_ticket = Some(ticket);
                app.desktop.mirror_released = false;
                app.desktop.mirror_sync_at = None;
                if app.desktop.surface.as_ref().is_none_or(|surface| {
                    surface.media_frame_kind() != crate::wallpaper::session::FrameKind::Image
                }) {
                    app.desktop.mirror_presented = None;
                }
                app.desktop.playlist = None;
            });
        }
    }

    /// Wait for every runnable member's superseded source to finish its real
    /// handoff before qualification can request a decoder for the new item.
    pub(super) fn mirror_sources_releasing(&mut self) -> bool {
        let id = self.desktop.configuration.main().id.clone();
        let keys: Vec<_> = self
            .mirror_members(&id)
            .into_iter()
            .filter(|member| member.runnable)
            .map(|member| member.key)
            .collect();
        let stale = keys.iter().any(|key| {
            self.with_desktop(key, |app| {
                app.desktop.surface.as_ref().is_some_and(|surface| {
                    !surface.static_poster && !app.mirror_surface_matches(surface)
                })
            })
            .unwrap_or(false)
        });
        stale || !self.wallpaper_retiring.is_empty()
    }

    pub(super) fn retry_failed_mirrors_after_apply(&mut self) {
        let ids: Vec<_> = self
            .desktop
            .mirrors
            .iter()
            .filter(|(_, group)| group.playback.is_failed())
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if self.config.wallpaper.enabled {
                let _ = self.mirror_next(&id, true);
            }
        }
    }

    pub(super) fn install_mirror_playlist(&mut self, playlist: Playlist) {
        let id = self.desktop.configuration.main().id.clone();
        let unchanged = self
            .desktop
            .mirrors
            .get(&id)
            .and_then(|group| group.playback.playlist())
            .is_some_and(|current| {
                current.playlist_id == playlist.playlist_id && current.revision == playlist.revision
            });
        if unchanged {
            self.desktop.playlist_reload_needed = false;
            return;
        }
        let now = Instant::now();
        self.wallpaper_generation += 1;
        let source = Source::Playlist(playlist);
        if let Some(group) = self.desktop.mirrors.get_mut(&id) {
            group.source_generation = self.wallpaper_generation;
            if group
                .playback
                .replace_source(source, self.wallpaper_generation.max(1), now)
                .is_err()
            {
                return;
            }
            group.playback.initial();
        } else if let Ok(mut playback) =
            GroupPlayback::new(source, self.wallpaper_generation.max(1), now)
        {
            playback.initial();
            self.desktop.mirrors.insert(
                id,
                MirrorRuntime {
                    selection: serde_json::to_value(&self.desktop.configuration.main().selection)
                        .unwrap(),
                    playback,
                    source_generation: self.wallpaper_generation,
                },
            );
        }
        self.reconcile_mirror_playback(now);
        self.desktop.playlist_reload_needed = false;
    }

    pub(super) fn mirror_switch(&self) -> Option<Switch> {
        self.desktop
            .mirror_ticket
            .as_ref()
            .map(|ticket| ticket.switch.clone())
    }

    pub(super) fn mirror_surface_matches(&self, surface: &WallpaperSurface) -> bool {
        self.desktop.mirror_ticket.as_ref().is_some_and(|ticket| {
            surface.playlist_token == Some(ticket.switch.token)
                && self
                    .desktop
                    .mirrors
                    .get(&self.desktop.configuration.main().id)
                    .is_some_and(|group| {
                        surface.mirror_source_generation == Some(group.source_generation)
                    })
                && surface.runtime_reference.as_ref() == Some(&ticket.switch.reference)
                && wallpaper_desktop::same_render_intent(
                    &surface.configuration,
                    &self.desktop.configuration,
                )
                && !surface.static_poster
        })
    }

    /// Called before promotion. Hidden readiness never counts as a shown item.
    pub(super) fn mirror_candidate_ready(&mut self) -> bool {
        if !self.is_mirror_target() {
            return true;
        }
        if self
            .desktop
            .candidate
            .as_ref()
            .is_some_and(|surface| surface.static_poster)
        {
            return self.desktop.failed_revision == Some(self.desktop.desired_revision);
        }
        let Some(ticket) = self.desktop.mirror_ticket.clone() else {
            return false;
        };
        if !self
            .desktop
            .candidate
            .as_ref()
            .is_some_and(|surface| self.mirror_surface_matches(surface))
        {
            return false;
        }
        let id = self.desktop.configuration.main().id.clone();
        let accepted = self
            .desktop
            .mirrors
            .get_mut(&id)
            .is_some_and(|group| group.playback.ready(&ticket));
        accepted && self.desktop.mirror_released
    }

    pub(super) fn mirror_presented(&mut self, generation: u64) -> bool {
        if !self.is_mirror_target() {
            return true;
        }
        let Some(ticket) = self.desktop.mirror_ticket.clone() else {
            return false;
        };
        if !self.desktop.mirror_released
            || !self.desktop.surface.as_ref().is_some_and(|surface| {
                surface.binding.generation() == generation && self.mirror_surface_matches(surface)
            })
        {
            return false;
        }
        let id = self.desktop.configuration.main().id.clone();
        let accepted = self
            .desktop
            .mirrors
            .get_mut(&id)
            .is_some_and(|group| group.playback.presented(&ticket, Instant::now()));
        if accepted {
            self.desktop.mirror_presented = Some(generation);
        }
        accepted
    }

    /// Fail the whole pending switch instead of letting faster members advance.
    pub(super) fn fail_mirror_target(&mut self) {
        let Some(ticket) = self.desktop.mirror_ticket.clone() else {
            return;
        };
        let id = self.desktop.configuration.main().id.clone();
        if let Some(group) = self.desktop.mirrors.get_mut(&id) {
            group.playback.fail(&ticket, Instant::now());
        }
    }

    pub(super) fn tick_mirror_playback(&mut self) {
        let now = Instant::now();
        self.reconcile_mirror_playback(now);
        let keys: Vec<_> = self
            .desktop
            .runtimes
            .iter()
            .filter(|(_, runtime)| {
                !runtime.closing && runtime.configuration.main().mode == LayoutMode::Mirror
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in &keys {
            self.with_desktop(key, |app| {
                if app.desktop.failed_revision == Some(app.desktop.desired_revision) {
                    app.fail_mirror_target();
                }
                if (app.desktop.mirror_ticket.is_some() || app.desktop.playlist_reload_needed)
                    && app.desktop.surface.as_ref().is_some_and(|surface| {
                        !surface.static_poster && !app.mirror_surface_matches(surface)
                    })
                    && app.wallpaper_render_allowed()
                {
                    // A group with two live videos holds both decoder slots.
                    // Preserve and retire old frames before any member requests
                    // a qualification decoder for the next shared item.
                    if let Err(error) = app.prepare_wallpaper_handoff() {
                        app.desktop.failed_revision = Some(app.desktop.desired_revision);
                        app.desktop.apply_error = Some(error.to_string());
                        app.fail_mirror_target();
                    }
                }
                if app.desktop.mirror_released
                    && app.desktop.surface.is_none()
                    && app.desktop.candidate.is_none()
                    && app.desktop.prepared.is_none()
                    && app.desktop.selection.is_none()
                    && app.desktop.failed_revision.is_none()
                {
                    let id = app.desktop.configuration.main().id.clone();
                    if let Some(group) = app.desktop.mirrors.get_mut(&id) {
                        group.playback.rebuild_member(key);
                    }
                    app.desktop.mirror_released = false;
                    app.desktop.mirror_presented = None;
                }
                // Reuse a paused still-valid controller; a geometry/recovery
                // rebuild receives a new ticket through the explicit invalidation.
                let ready = app.desktop.surface.as_ref().is_some_and(|surface| {
                    app.mirror_surface_matches(surface)
                        && surface.first_frame_ready()
                        && native::wallpaper_alive(surface.hwnd())
                });
                if ready {
                    if let Some(ticket) = app.desktop.mirror_ticket.clone() {
                        let id = app.desktop.configuration.main().id.clone();
                        if let Some(group) = app.desktop.mirrors.get_mut(&id) {
                            group.playback.ready(&ticket);
                        }
                    }
                }
            });
        }
        self.dispatch_mirror_prepares();
        let failed: Vec<_> = self
            .desktop
            .mirrors
            .iter()
            .filter(|(_, group)| group.playback.is_failed())
            .map(|(id, _)| id.clone())
            .collect();
        for key in &keys {
            if self
                .desktop
                .runtimes
                .get(key)
                .is_some_and(|runtime| failed.contains(&runtime.configuration.main().id))
            {
                self.with_desktop(key, |app| {
                    app.cancel_mirror_failure_transition();
                    app.desktop.failed_revision = Some(app.desktop.desired_revision);
                    app.desktop
                        .apply_error
                        .get_or_insert_with(|| "镜像组的作品切换失败，已保留原画面；请重试".into());
                    if app
                        .desktop
                        .surface
                        .as_ref()
                        .is_some_and(|surface| !surface.static_poster)
                    {
                        let _ = app.prepare_wallpaper_handoff();
                    }
                    app.recompute_wallpaper();
                });
            }
        }
        let reveals: Vec<_> = self
            .desktop
            .mirrors
            .values_mut()
            .flat_map(|group| group.playback.take_reveals(now))
            .collect();
        for ticket in reveals {
            self.with_desktop(&ticket.key, |app| {
                app.desktop.mirror_released = true;
                if app.desktop.candidate.is_some() {
                    app.promote_wallpaper_candidate();
                } else {
                    app.recompute_wallpaper();
                }
                // An unchanged image is still the actual displayed frame and
                // has no asynchronous seek to acknowledge on policy resume.
                if let Some(generation) = app
                    .desktop
                    .surface
                    .as_ref()
                    .filter(|surface| {
                        surface.media_frame_kind() == crate::wallpaper::session::FrameKind::Image
                            && app.desktop.mirror_presented == Some(surface.binding.generation())
                    })
                    .map(|surface| surface.binding.generation())
                {
                    app.mirror_presented(generation);
                }
            });
        }
        for key in keys {
            self.with_desktop(&key, |app| app.send_mirror_clock(now));
        }
        if self.wallpaper_apply.is_none() {
            for group in self.desktop.mirrors.values_mut() {
                group.playback.tick(now);
            }
        }
        self.dispatch_mirror_prepares();
    }

    fn send_mirror_clock(&mut self, now: Instant) {
        let id = self.desktop.configuration.main().id.clone();
        let Some(group) = self.desktop.mirrors.get_mut(&id) else {
            return;
        };
        if group.playback.is_failed() {
            return;
        }
        let time = group.playback.content_time(now).unwrap_or_default();
        if !self.desktop.mirror_released
            || !self.wallpaper_render_allowed()
            || !self.wallpaper_target_running(&self.desktop.configuration)
        {
            return;
        }
        let Some(surface) = self
            .desktop
            .surface
            .as_ref()
            .filter(|surface| self.mirror_surface_matches(surface))
        else {
            return;
        };
        if surface.media_frame_kind() != crate::wallpaper::session::FrameKind::Video {
            return;
        }
        let generation = surface.binding.generation();
        let clock = self
            .desktop
            .mirror_clock
            .filter(|(expected, clock)| {
                *expected == generation
                    && now.saturating_duration_since(clock.native_ready) < Duration::from_secs(10)
            })
            .map(|(_, clock)| clock);
        let Some(clock) = clock else {
            let pending = self
                .desktop
                .mirror_clock_pending
                .is_some_and(|(expected, at)| {
                    expected == generation
                        && now.saturating_duration_since(at) < Duration::from_secs(1)
                });
            if !pending {
                let proxy = self.proxy.clone();
                if surface
                    .webview
                    .evaluate_script_with_callback("performance.now()", move |value| {
                        let received = Instant::now();
                        let page_ms = serde_json::from_str::<f64>(&value).ok();
                        let _ = proxy.send_event(UserEvent::WallpaperMirrorClock(
                            generation, now, received, page_ms,
                        ));
                    })
                    .is_ok()
                {
                    self.desktop.mirror_clock_pending = Some((generation, now));
                }
            }
            return;
        };
        let revealed = self.desktop.mirror_presented == Some(surface.binding.generation());
        if revealed
            && self
                .desktop
                .mirror_sync_at
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(2))
        {
            return;
        }
        let request = serde_json::json!({"token":self.desktop.mirror_clock_token,"timeMs":time.as_millis().min(u128::from(u64::MAX)) as u64,
            "pageDispatchMs":clock.at(now),"running":surface.configuration.presentation().motion > 0.0});
        let method = if revealed {
            "syncMediaClock"
        } else {
            "revealMediaClock"
        };
        surface.eval(&format!(
            "window.hertzWallpaper && window.hertzWallpaper.{method}({request});"
        ));
        self.desktop.mirror_sync_at = Some(now);
    }

    pub(super) fn accept_mirror_clock(
        &mut self,
        generation: u64,
        sent: Instant,
        received: Instant,
        page_ms: Option<f64>,
    ) {
        let Some(key) = self.desktop.route_generation(generation) else {
            return;
        };
        self.with_desktop(&key, |app| {
            if app.desktop.mirror_clock_pending != Some((generation, sent)) {
                return;
            }
            app.desktop.mirror_clock_pending = None;
            if app
                .desktop
                .surface
                .as_ref()
                .is_none_or(|surface| surface.binding.generation() != generation)
            {
                return;
            }
            if let Some(clock) = calibrated_clock(sent, received, page_ms) {
                app.desktop.mirror_clock = Some((generation, clock));
            }
        });
    }

    pub(super) fn mirror_next(
        &mut self,
        group_id: &str,
        retry: bool,
    ) -> std::result::Result<serde_json::Value, JobError> {
        if self.wallpaper_apply.is_some() {
            return Err(JobError::new("budget_busy", "显示组正在应用"));
        }
        let group = self
            .desktop
            .mirrors
            .get_mut(group_id)
            .ok_or_else(|| JobError::new("playlist_not_ready", "镜像组尚未准备完成"))?;
        let switch = if retry {
            group.playback.retry(Instant::now())?
        } else {
            group.playback.next()?
        };
        for runtime in self
            .desktop
            .runtimes
            .values_mut()
            .filter(|runtime| runtime.configuration.main().id == group_id)
        {
            runtime.failed_revision = None;
            runtime.apply_error = None;
        }
        self.dispatch_mirror_prepares();
        Ok(serde_json::json!({"pendingIndex":switch.index}))
    }

    pub(super) fn mirror_status(&self, group_id: &str) -> Option<serde_json::Value> {
        let group = self.desktop.mirrors.get(group_id)?;
        let playlist = group.playback.playlist()?;
        Some(
            serde_json::json!({"playlistId":playlist.playlist_id,"playlistRevision":playlist.revision,
            "title":playlist.title,"mode":playlist.mode,"intervalSeconds":playlist.interval_seconds,
            "currentIndex":group.playback.current_index(),"pendingIndex":group.playback.switch().filter(|_| group.playback.is_switching()).map(|switch| switch.index),
            "itemCount":playlist.items.len(),"failed":group.playback.is_failed(),"current":group.playback.current(),"sharedGroupClock":true}),
        )
    }
}

/// The page sample was taken between dispatch and callback. Midpoint error is
/// bounded by half the round trip; reject slow samples instead of adding an
/// unknown upstream beacon delay to the group's video phase.
fn calibrated_clock(sent: Instant, received: Instant, page_ms: Option<f64>) -> Option<PageClock> {
    let elapsed = received.checked_duration_since(sent)?;
    let page_ready_ms = page_ms.filter(|value| value.is_finite() && *value >= 0.0)?;
    if elapsed > Duration::from_millis(40) {
        return None;
    }
    Some(PageClock {
        native_ready: sent + elapsed / 2,
        page_ready_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_clock_uses_a_bounded_round_trip_not_upstream_beacon_age() {
        let sent = Instant::now();
        let clock = calibrated_clock(sent, sent + Duration::from_millis(20), Some(500.0)).unwrap();
        assert_eq!(clock.at(sent + Duration::from_millis(30)), 520.0);
        assert!(calibrated_clock(sent, sent + Duration::from_millis(200), Some(500.0)).is_none());
        assert!(calibrated_clock(sent, sent, Some(f64::NAN)).is_none());
        assert!(calibrated_clock(sent, sent, Some(-1.0)).is_none());
    }
}
