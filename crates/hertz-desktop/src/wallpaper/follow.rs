// SPDX-License-Identifier: MIT
//! Resolve the native scene projection without changing the saved follow intent.
use super::config::{BuiltinState, WallpaperConfig};
use crate::wallpaper_feed::Snapshot;
use std::time::{Duration, Instant};

pub(crate) fn resolve(
    configuration: &WallpaperConfig,
    snapshot: Option<&Snapshot>,
) -> Option<BuiltinState> {
    let idle = configuration.builtin()?;
    if !configuration.follows_hertz() {
        return Some(idle);
    }
    let active = snapshot
        .filter(|snapshot| {
            snapshot.valid
                && snapshot.received_at.is_some_and(|at| {
                    Instant::now().saturating_duration_since(at) < Duration::from_secs(3)
                })
        })
        .and_then(|snapshot| snapshot.space.as_ref())
        .and_then(|space| {
            let scene = hertz_wallpaper::catalog().scenes.iter().find(|scene| {
                scene["id"].as_str() == Some(space.scene.as_str())
                    || scene["aliases"].as_array().is_some_and(|aliases| {
                        aliases
                            .iter()
                            .any(|alias| alias.as_str() == Some(space.scene.as_str()))
                    })
            })?;
            let mut state = BuiltinState {
                scene_id: scene["id"].as_str()?.into(),
                state_version: scene["stateVersion"].as_u64()?.try_into().ok()?,
                params: space.params.as_object()?.clone(),
            };
            super::config::normalize_builtin(
                &state.scene_id,
                state.state_version,
                &mut state.params,
            )
            .ok()?;
            Some(state)
        });
    Some(active.unwrap_or(idle))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> Snapshot {
        serde_json::from_value(serde_json::json!({"protocol":2,"seq":1,"server":{"session":"test","edition":"full","version":"1"},"valid":true,"playing":false,"positionMs":0,"durationMs":null,"generation":"1","spectrum":{"bands":vec![0.;64],"energy":0.,"ageMs":0},"space":{"scene":"coast","params":{}},"timing":"monotonic"})).unwrap()
    }
    #[test]
    fn fresh_follow_uses_registry_defaults_without_mutating_intent() {
        let configuration = WallpaperConfig::default();
        let saved = serde_json::to_value(&configuration).unwrap();
        let mut snapshot = snapshot();
        snapshot.received_at = Some(Instant::now());
        let selected = resolve(&configuration, Some(&snapshot)).unwrap();
        assert_eq!(selected.scene_id, "coast");
        assert!(!selected.params.is_empty());
        assert_eq!(serde_json::to_value(configuration).unwrap(), saved);
    }
    #[test]
    fn stale_invalid_or_ineligible_follow_returns_configured_idle() {
        let configuration = WallpaperConfig::default();
        let idle = configuration.builtin();
        let mut snapshot = snapshot();
        assert_eq!(resolve(&configuration, Some(&snapshot)), idle);
        snapshot.received_at = Some(Instant::now() - Duration::from_secs(3));
        assert_eq!(resolve(&configuration, Some(&snapshot)), idle);
        snapshot.received_at = Some(Instant::now());
        snapshot.valid = false;
        assert_eq!(resolve(&configuration, Some(&snapshot)), idle);
        snapshot.valid = true;
        snapshot.space.as_mut().unwrap().params = serde_json::json!({"invented":true});
        assert_eq!(resolve(&configuration, Some(&snapshot)), idle);
        snapshot.space.as_mut().unwrap().scene = "not-registered".into();
        assert_eq!(resolve(&configuration, Some(&snapshot)), idle);
    }
}
