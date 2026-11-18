// SPDX-License-Identifier: MIT
//! Security changes stop original sessions/preview/prepare owners by full hash.
use super::*;

fn uses(runtime: &wallpaper_runtime::DesktopRuntime, hash: &str) -> bool {
    let selection = |surface: &WallpaperSurface| {
        surface.configuration.references_package(None, Some(hash))
            || surface
                .runtime_reference
                .as_ref()
                .is_some_and(|r| r.package_hash == hash)
    };
    runtime.configuration.references_package(None, Some(hash))
        || runtime.surface.as_ref().is_some_and(selection)
        || runtime.candidate.as_ref().is_some_and(selection)
        || runtime
            .selection
            .as_ref()
            .is_some_and(|task| task.references_package(None, Some(hash)))
        || runtime
            .prepared
            .as_ref()
            .is_some_and(|p| p.references_package(None, Some(hash)))
        || runtime
            .policy_poster
            .as_ref()
            .is_some_and(|p| p.references_package(None, Some(hash)))
        || runtime.playlist.as_ref().is_some_and(|p| {
            p.current().is_some_and(|r| r.package_hash == hash)
                || p.pending_fixed().is_some_and(|r| r.package_hash == hash)
        })
}

impl App {
    pub(super) fn tick_community_security(&mut self) {
        let snapshot = self.wallpaper_library.security_snapshot(
            self.wallpaper_community.security_revision,
            self.wallpaper_community.security_due,
        );
        let snapshot = match snapshot {
            Ok(Some(s)) => s,
            Ok(None) => {
                self.wallpaper_community.security_unavailable = false;
                return;
            }
            Err(_) => {
                if self.wallpaper_community.security_unavailable {
                    return;
                }
                self.wallpaper_community.security_unavailable = true;
                if let Some(tx) = self.wallpaper_apply.as_ref() {
                    tx.cancel_for_feature_exit();
                }
                self.close_preview();
                self.for_each_desktop(|app| {
                    if app.desktop.configuration.builtin().is_none() {
                        app.desktop.failed_revision = Some(app.desktop.desired_revision);
                        app.desktop.apply_error = Some("安全状态不可用，内容已停止".into());
                        app.drop_wallpaper_surface_target();
                    }
                });
                return;
            }
        };
        self.wallpaper_community.security_unavailable = false;
        self.wallpaper_community.security_revision = snapshot.revision;
        self.wallpaper_community.security_due = snapshot.next_due;
        let observed = snapshot.observed_at;
        if self
            .wallpaper_library
            .external_request(move |jobs| async move {
                if let Ok(jobs) = jobs {
                    if let Err(e) = jobs.library().trust().persist_observed_time(observed).await {
                        log(&format!("community security time: {}", e.code));
                    }
                }
            })
            .is_err()
        {
            self.wallpaper_community.next_sync = Instant::now();
        }
        for hash in &snapshot.hashes {
            if self
                .wallpaper_apply
                .as_ref()
                .is_some_and(|t| t.references_package(None, Some(hash)))
            {
                if let Some(tx) = self.wallpaper_apply.as_ref() {
                    tx.cancel_for_feature_exit();
                }
            }
            if self
                .preview
                .as_ref()
                .is_some_and(|p| p.references_package(None, Some(hash)))
            {
                self.close_preview();
            }
            let targets: Vec<_> = self
                .desktop
                .runtimes
                .iter()
                .filter(|(_, r)| uses(r, hash))
                .map(|(key, _)| key.clone())
                .collect();
            for key in targets {
                self.with_desktop(&key, |app| {
                    app.desktop.failed_revision = Some(app.desktop.desired_revision);
                    app.desktop.apply_error =
                        Some("此完整包哈希已被安全撤销，活动内容已停止".into());
                    app.desktop.recovery_terminal = true;
                    app.fail_mirror_target();
                    app.drop_wallpaper_surface_target();
                });
            }
            self.wallpaper_community
                .automatic
                .retain(|a| a.candidate.package_hash != *hash);
        }
    }
}
