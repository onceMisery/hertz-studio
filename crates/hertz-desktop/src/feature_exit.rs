// SPDX-License-Identifier: MIT
//! Session stop facts live with App; Config remains the only preference owner.

use super::*;

#[derive(Clone, Copy)]
pub(super) enum Feature {
    Lyrics,
    Wallpaper,
}

#[derive(Default)]
pub(super) struct FeatureStops {
    pub(super) lyrics: bool,
    pub(super) wallpaper: bool,
    pub(super) lyrics_save_failed: bool,
    pub(super) wallpaper_save_failed: bool,
}

impl App {
    pub(super) fn lyrics_running(&self) -> bool {
        self.config.lyrics.enabled && !self.feature_stops.lyrics
    }

    pub(super) fn wallpaper_running(&self) -> bool {
        self.wallpaper_target_running(&self.config.wallpaper)
    }

    pub(super) fn wallpaper_target_running(&self, candidate: &config::WallpaperConfig) -> bool {
        !self.feature_stops.wallpaper && (candidate.enabled || self.wallpaper_forced)
    }

    pub(super) fn lyrics_needed(&self) -> bool {
        !self.feature_stops.lyrics && (self.config.lyrics.enabled || self.settings.is_some())
    }

    pub(super) fn sync_lyrics_feed(&mut self) {
        if config::is_dbx(&self.profile) {
            self.sync_dbx_feed();
            return;
        }
        if !self.lyrics_needed() || self.config.active_profile.is_none() {
            self.lyrics_feed_stop.store(true, Ordering::Release);
            return;
        }
        if self.lyrics_feed_stop.load(Ordering::Acquire) {
            self.lyrics_feed_stop = Arc::new(AtomicBool::new(false));
            spawn_feed(
                self.profile.clone(),
                self.proxy.clone(),
                self.source_generation,
                self.lyrics_feed_stop.clone(),
            );
        }
    }

    pub(super) fn resume_lyrics(&mut self) {
        self.feature_stops.lyrics = false;
        self.feature_stops.lyrics_save_failed = false;
        self.sync_lyrics_feed();
    }

    pub(super) fn clear_lyrics_runtime(&mut self) {
        self.lyrics_feed_stop.store(true, Ordering::Release);
        self.source_health.fail(true);
        self.last_snapshot = None;
        self.current_track = None;
        self.current_document_key = None;
        self.current_document = None;
        self.page_clock = None;
        self.policy.no_content = true;
        self.source_state = "stopped";
        self.source_message = None;
        self.eval("window.hertzLyrics && window.hertzLyrics.applyDocument(null);");
        self.send_snapshot();
        self.send_source();
        self.recompute_visibility();
    }

    pub(super) fn exit_feature(&mut self, feature: Feature) -> serde_json::Value {
        // Invalidate old combined Apply work before it can commit or restart a feature.
        if let Some(transaction) = &self.wallpaper_apply {
            transaction.cancel_for_feature_exit();
        }
        match feature {
            Feature::Lyrics => {
                self.feature_stops.lyrics = true;
                let _ = self.finish_position_edit(false);
                self.clear_lyrics_runtime();
            }
            Feature::Wallpaper => {
                self.feature_stops.wallpaper = true;
                self.wallpaper_forced = false;
                self.close_preview();
                self.wallpaper_audio_dispatch.invalidate();
                self.drop_wallpaper_surface();
                self.reconcile_mirror_playback(Instant::now());
                self.stop_wallpaper_feed();
                self.wallpaper_last = None;
                self.wallpaper_last_update = None;
            }
        }
        self.sync_settings_feed();

        // Exit commits only the durable feature preference. Pending style/position
        // edits and center drafts never become part of this transaction.
        let mut next = self.committed_config.clone();
        match feature {
            Feature::Lyrics => next.lyrics.enabled = false,
            Feature::Wallpaper => next.wallpaper.enabled = false,
        }
        let saved = config::commit(&mut self.committed_config, next).is_ok();
        if saved {
            self.config.revision = self.committed_config.revision;
            self.config.last_commit = self.committed_config.last_commit.clone();
            self.config.profiles = self.committed_config.profiles.clone();
            match feature {
                Feature::Lyrics => self.config.lyrics.enabled = false,
                Feature::Wallpaper => self.config.wallpaper.enabled = false,
            }
        }
        match feature {
            Feature::Lyrics => self.feature_stops.lyrics_save_failed = !saved,
            Feature::Wallpaper => self.feature_stops.wallpaper_save_failed = !saved,
        }
        self.sync_settings_feed();
        self.rebuild_tray();
        let message = (!saved).then_some("本次功能已退出；退出偏好未保存，再次启动可能恢复");
        self.send_settings_status(message, None);
        if let Some(message) = message {
            native::dialog_error(message);
        }
        let mut response = self.status_json();
        response["runtimeStopped"] = true.into();
        response["saved"] = saved.into();
        response["persistenceError"] = message.map(serde_json::Value::from).unwrap_or_default();
        response
    }

    pub(super) fn can_finish_feature_exit(&self) -> bool {
        (self.feature_stops.lyrics || self.feature_stops.wallpaper)
            && !self.lyrics_running()
            && !self.wallpaper_running()
            && self.settings.is_none()
            && self.mini_host.phase == MiniPhase::Hidden
            && self.mini_restore_pending.is_none()
            && self.wallpaper_apply.is_none()
            && self.save_due.is_none()
    }

    pub(super) fn maybe_finish_feature_exit(&self) {
        if self.can_finish_feature_exit() {
            let _ = self.proxy.send_event(UserEvent::FeatureIdleExit);
        }
    }
}
