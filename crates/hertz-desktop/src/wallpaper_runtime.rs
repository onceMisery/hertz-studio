// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! State owned by one physical desktop presentation. Configuration commits,
//! generation allocation, audio/feed owners, preview and real exit queues stay
//! with App. A display target can be replaced without replacing those owners.

use super::*;
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};

/// All owners stay in the registry during synchronous target dispatch. The cursor
/// never supplies a default target: a global caller must explicitly iterate.
#[derive(Default)]
pub(super) struct DesktopTargets {
    pub(super) runtimes: BTreeMap<String, DesktopRuntime>,
    pub(super) current: Option<String>,
    pub(super) topology: crate::wallpaper::display::DisplayTopology,
    pub(super) recovery: crate::wallpaper::session::RecoveryLedger,
    pub(super) mirrors: BTreeMap<String, wallpaper_mirror::MirrorRuntime>,
}

impl DesktopTargets {
    pub(super) fn route_generation(&self, generation: u64) -> Option<String> {
        self.runtimes
            .iter()
            .find_map(|(key, runtime)| runtime.owns_generation(generation).then(|| key.clone()))
    }

    pub(super) fn route_selection(&self, id: u64) -> Option<String> {
        self.runtimes.iter().find_map(|(key, runtime)| {
            runtime
                .selection
                .as_ref()
                .is_some_and(|task| task.id == id)
                .then(|| key.clone())
        })
    }
}

// Transitional field access for the existing target controller. Global services
// use runtimes directly; with_desktop is the only owner of the dispatch cursor.
impl Deref for DesktopTargets {
    type Target = DesktopRuntime;
    fn deref(&self) -> &Self::Target {
        let key = self
            .current
            .as_ref()
            .expect("desktop access outside target dispatch");
        self.runtimes
            .get(key)
            .expect("target removed during dispatch")
    }
}

impl DerefMut for DesktopTargets {
    fn deref_mut(&mut self) -> &mut Self::Target {
        let key = self
            .current
            .as_ref()
            .expect("desktop access outside target dispatch");
        self.runtimes
            .get_mut(key)
            .expect("target removed during dispatch")
    }
}

pub(super) struct DesktopRuntime {
    pub(super) target: Option<crate::wallpaper::display::DisplayTarget>,
    pub(super) closing: bool,
    /// One group's rendering intent; never used as the configuration commit owner.
    pub(super) configuration: config::WallpaperConfig,
    pub(super) desired_revision: u64,
    pub(super) surface: Option<WallpaperSurface>,
    pub(super) candidate: Option<WallpaperSurface>,
    pub(super) candidate_ticket: Option<crate::wallpaper::display::TargetTicket>,
    pub(super) handoff: Option<wallpaper_handoff::Handoff>,
    pub(super) prepared: Option<wallpaper_desktop::Prepared>,
    pub(super) policy_poster: Option<wallpaper_desktop::Prepared>,
    pub(super) playback: Option<wallpaper_desktop::PlaybackResume>,
    pub(super) selection: Option<wallpaper_desktop::SelectionTask>,
    pub(super) failed_revision: Option<u64>,
    pub(super) page_ready: bool,
    pub(super) heartbeat_at: Option<Instant>,
    pub(super) heartbeat_ticks: u64,
    pub(super) heartbeat_draws: u64,
    pub(super) fps_sample: Option<(Instant, u64)>,
    pub(super) measured_fps: Option<f64>,
    pub(super) visible: bool,
    pub(super) apply_error: Option<String>,
    pub(super) fullscreen_gate: policy::Debounce,
    pub(super) maximized_gate: policy::Debounce,
    pub(super) application_gate: policy::ApplicationRuleGate,
    pub(super) policy_released: bool,
    pub(super) pause_capture_attempted: bool,
    pub(super) topology_misses: u8,
    pub(super) recovery_attempts: Vec<Instant>,
    pub(super) recovery_terminal: bool,
    pub(super) monitor_missing: bool,
    pub(super) playlist: Option<crate::wallpaper::playlist::Runner>,
    pub(super) playlist_epoch: u64,
    pub(super) playlist_reload_needed: bool,
    pub(super) mirror_ticket: Option<crate::wallpaper::group_playback::MemberTicket>,
    pub(super) mirror_rebuild: bool,
    pub(super) mirror_released: bool,
    pub(super) mirror_presented: Option<u64>,
    pub(super) mirror_sync_at: Option<Instant>,
    pub(super) mirror_clock_token: u64,
    pub(super) mirror_clock: Option<(u64, PageClock)>,
    pub(super) mirror_clock_pending: Option<(u64, Instant)>,
}

impl DesktopRuntime {
    pub(super) fn new(
        configuration: config::WallpaperConfig,
        desired_revision: u64,
        surface: Option<WallpaperSurface>,
        monitor_missing: bool,
    ) -> Self {
        Self {
            target: None,
            closing: false,
            configuration,
            desired_revision,
            surface,
            candidate: None,
            candidate_ticket: None,
            handoff: None,
            prepared: None,
            policy_poster: None,
            playback: None,
            selection: None,
            failed_revision: None,
            page_ready: false,
            heartbeat_at: None,
            heartbeat_ticks: 0,
            heartbeat_draws: 0,
            fps_sample: None,
            measured_fps: None,
            visible: false,
            apply_error: None,
            fullscreen_gate: policy::Debounce::new(false),
            maximized_gate: policy::Debounce::window_policy(false),
            application_gate: policy::ApplicationRuleGate::new(None),
            policy_released: false,
            pause_capture_attempted: false,
            topology_misses: 0,
            recovery_attempts: Vec::new(),
            recovery_terminal: false,
            monitor_missing,
            playlist: None,
            playlist_epoch: 0,
            playlist_reload_needed: false,
            mirror_ticket: None,
            mirror_rebuild: false,
            mirror_released: false,
            mirror_presented: None,
            mirror_sync_at: None,
            mirror_clock_token: 0,
            mirror_clock: None,
            mirror_clock_pending: None,
        }
    }

    /// Unrelated settings commits do not invalidate this target's preparation or
    /// playback position. Its revision advances only with its rendering intent.
    pub(super) fn configure(&mut self, configuration: config::WallpaperConfig, revision: u64) {
        if !wallpaper_desktop::same_render_intent(&self.configuration, &configuration) {
            self.desired_revision = revision;
            self.playback = None;
            self.policy_poster = None;
            self.failed_revision = None;
            self.recovery_terminal = false;
            self.recovery_attempts.clear();
            self.mirror_rebuild = true;
        }
        self.configuration = configuration;
    }

    fn owns_generation(&self, generation: u64) -> bool {
        self.surface
            .iter()
            .chain(self.candidate.iter())
            .any(|surface| surface.binding.generation() == generation)
            || self
                .handoff
                .as_ref()
                .is_some_and(|handoff| handoff.hold.request.generation == generation)
            || self
                .playback
                .as_ref()
                .is_some_and(|resume| resume.generation() == generation)
    }
}

impl App {
    /// A scope cannot span App event dispatch or mutate the registry's structure.
    /// Wry may pump Win32 messages during creation; Tao buffers UserEvents while
    /// this App callback is borrowed, and every page callback only queues IPC.
    /// Nested explicit routing restores its caller; stale keys have no fallback.
    pub(super) fn with_desktop<R>(
        &mut self,
        key: &str,
        run: impl FnOnce(&mut Self) -> R,
    ) -> Option<R> {
        if !self.desktop.runtimes.contains_key(key) {
            return None;
        }
        let previous = self.desktop.current.replace(key.to_owned());
        let result = run(self);
        self.desktop.current = previous;
        Some(result)
    }

    pub(super) fn for_each_desktop(&mut self, mut run: impl FnMut(&mut Self)) {
        let keys: Vec<_> = match &self.desktop.current {
            Some(key) => vec![key.clone()],
            None => self
                .desktop
                .runtimes
                .iter()
                .filter(|(_, desktop)| !desktop.closing)
                .map(|(key, _)| key.clone())
                .collect(),
        };
        for key in keys {
            self.with_desktop(&key, |app| run(app));
        }
    }

    /// Replanning is only allowed at the global boundary. Removed owners drain
    /// their selections/controllers before their state may leave the registry.
    pub(super) fn reconcile_desktops(
        &mut self,
        monitors: &[native::WallpaperMonitor],
        now: Instant,
    ) -> Result<()> {
        assert!(
            self.desktop.current.is_none(),
            "replanning during target dispatch"
        );
        let plan = self
            .desktop
            .topology
            .reconcile(&self.config.wallpaper.groups, monitors, now)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let removed: Vec<_> = self
            .desktop
            .runtimes
            .keys()
            .filter(|key| !plan.targets.iter().any(|target| &target.id == *key))
            .cloned()
            .collect();
        for key in removed {
            self.with_desktop(&key, |app| {
                app.desktop.closing = true;
                app.desktop.monitor_missing = true;
                app.drop_wallpaper_surface_target();
            });
        }
        for target in plan.targets {
            let mut configuration =
                project_group(&self.config.wallpaper, &target.group_id).expect("planned group");
            if self.feature_stops.wallpaper {
                configuration.enabled = false;
            }
            if let Some(runtime) = self.desktop.runtimes.get_mut(&target.id) {
                runtime.closing = false;
                runtime.monitor_missing = false;
                runtime.configure(configuration, self.config.revision);
                runtime.target = Some(target);
            } else if !target.retained {
                let mut runtime =
                    DesktopRuntime::new(configuration, self.config.revision, None, false);
                runtime.target = Some(target.clone());
                self.desktop.runtimes.insert(target.id.clone(), runtime);
            }
        }
        self.desktop
            .runtimes
            .retain(|_, runtime| !runtime.closing || runtime.selection.is_some());
        self.reconcile_mirror_playback(now);
        Ok(())
    }

    /// Resolve again immediately before creation/admission. A grace target can
    /// keep its old renderer but never authorizes a new controller or resize.
    pub(super) fn desktop_monitor(&self) -> Option<native::WallpaperMonitor> {
        let descriptor = self.desktop.target.as_ref()?;
        if descriptor.retained || self.desktop.closing {
            return None;
        }
        let mut topology = crate::wallpaper::display::DisplayTopology::default();
        topology
            .reconcile(
                &self.desktop.configuration.groups,
                &native::wallpaper_monitors(),
                Instant::now(),
            )
            .ok()?
            .targets
            .into_iter()
            .find(|target| target.id == descriptor.id && !target.retained)
            .map(|target| target.monitor())
    }
}

pub(super) fn project_group(
    configuration: &config::WallpaperConfig,
    id: &str,
) -> Option<config::WallpaperConfig> {
    let group = configuration
        .groups
        .iter()
        .find(|group| group.id == id)?
        .clone();
    let mut projected = configuration.clone();
    projected.groups = vec![group];
    Some(projected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrelated_commit_preserves_target_revision_but_changed_intent_advances_it() {
        let configuration = config::WallpaperConfig::default();
        let mut runtime = DesktopRuntime::new(configuration.clone(), 4, None, false);
        runtime.configure(configuration.clone(), 5);
        assert_eq!(runtime.desired_revision, 4);
        let mut next = configuration;
        next.main_mut().presentation.brightness = 0.4;
        runtime.configure(next, 6);
        assert_eq!(runtime.desired_revision, 6);
        assert_eq!(runtime.configuration.presentation().brightness, 0.4);
    }

    #[test]
    fn window_policy_commit_preserves_render_revision_and_failed_item() {
        use crate::wallpaper::config::{ApplicationRule, RuleAction};
        let configuration = config::WallpaperConfig::default();
        let mut runtime = DesktopRuntime::new(configuration.clone(), 4, None, false);
        runtime.failed_revision = Some(4);
        let mut next = configuration;
        next.pause_on_fullscreen = false;
        next.pause_on_maximized = true;
        next.application_rules.push(ApplicationRule {
            executable: "c:\\games\\player.exe".into(),
            action: RuleAction::Stop,
        });
        runtime.configure(next, 5);
        assert_eq!(runtime.desired_revision, 4);
        assert_eq!(runtime.failed_revision, Some(4));
        assert!(!runtime.mirror_rebuild);
        assert!(runtime.configuration.pause_on_maximized);
        assert!(!runtime.configuration.pause_on_fullscreen);
        assert_eq!(runtime.configuration.application_rules.len(), 1);
    }
}
