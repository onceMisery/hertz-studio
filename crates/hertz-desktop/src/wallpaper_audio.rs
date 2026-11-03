// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The active desktop and settings preview share one loopback owner. A preview cannot
//! change the endpoint underneath an active desktop; Hertz metadata stays on its own feed.
use super::*;
use crate::wallpaper::{
    audio_service,
    config::{AudioDevice, AudioInput},
};

#[derive(Default)]
struct Sink {
    target: Option<String>,
    pending: Option<u64>,
    delivered: Option<(u64, u64)>,
}
#[derive(Default)]
pub(super) struct Dispatch {
    sinks: [Sink; 2],
    next: u64,
}
impl Dispatch {
    fn prepare(&mut self, slot: usize, target: Option<String>, key: (u64, u64)) -> Option<u64> {
        let sink = &mut self.sinks[slot];
        if sink.target != target {
            *sink = Sink {
                target,
                ..Default::default()
            };
        }
        if sink.target.is_none() || sink.pending.is_some() || sink.delivered == Some(key) {
            return None;
        }
        self.next += 1;
        sink.pending = Some(self.next);
        sink.delivered = Some(key);
        Some(self.next)
    }
    pub(super) fn acknowledge(&mut self, slot: usize, token: u64) {
        if let Some(sink) = self.sinks.get_mut(slot) {
            if sink.pending == Some(token) {
                sink.pending = None;
            }
        }
    }
    pub(super) fn invalidate(&mut self) {
        for sink in &mut self.sinks {
            sink.delivered = None;
        }
    }
}

fn system_device(config: &config::WallpaperConfig) -> Option<AudioDevice> {
    if config.builtin().is_none() || config.presentation().fps == 0 {
        return None;
    }
    match &config.audio_input {
        AudioInput::System { device, .. } => Some(device.clone()),
        _ => None,
    }
}

fn compatible(a: &AudioDevice, b: &AudioDevice, state: &audio_service::Snapshot) -> bool {
    if a == b {
        return true;
    }
    let resolved = |device: &AudioDevice| match device {
        AudioDevice::Default => state
            .endpoints
            .iter()
            .find(|item| item.is_default)
            .map(|item| item.id.clone()),
        AudioDevice::Fixed { id } => Some(id.clone()),
    };
    match (resolved(a), resolved(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

impl App {
    fn desktop_audio_device(&self) -> Option<AudioDevice> {
        self.wallpaper
            .as_ref()
            .filter(|_| self.wallpaper_visible)
            .and_then(|surface| system_device(&surface.configuration))
    }
    fn preview_audio_device(&self) -> Option<AudioDevice> {
        self.preview
            .as_ref()
            .filter(|preview| preview.lease_until > Instant::now())
            .and_then(|preview| preview.surface.as_ref())
            .filter(|surface| surface.first_frame_ready())
            .and_then(|surface| system_device(&surface.configuration))
    }
    pub(super) fn validate_preview_audio(
        &self,
        config: &config::WallpaperConfig,
    ) -> Result<(), String> {
        if let (Some(desktop), Some(preview)) = (self.desktop_audio_device(), system_device(config))
        {
            if !compatible(&desktop, &preview, &self.wallpaper_audio.snapshot()) {
                return Err(
                    "桌面正在使用其他系统音频设备；请选择相同设备，或先暂停桌面壁纸。".into(),
                );
            }
        }
        Ok(())
    }
    pub(super) fn sync_wallpaper_audio(&mut self) {
        let desktop = self.desktop_audio_device();
        let preview = self.preview_audio_device();
        let demand = desktop.clone().or(preview.clone());
        self.wallpaper_audio.request(demand.clone());
        let state = self.wallpaper_audio.snapshot();
        let preview_allowed = preview
            .as_ref()
            .zip(demand.as_ref())
            .is_some_and(|(preview, demand)| compatible(preview, demand, &state));
        let frame = state.frame.as_ref().filter(|frame| {
            frame.generation == state.generation
                && frame.captured_at.elapsed() < Duration::from_secs(1)
        });
        if let Some(surface) = self.wallpaper.as_ref() {
            let target = (self.wallpaper_page_ready
                && system_device(&surface.configuration).is_some())
            .then(|| format!("desktop:{}", surface.binding.generation()));
            let frame = if desktop.is_some() { frame } else { None };
            if let Some(token) = self.wallpaper_audio_dispatch.prepare(
                0,
                target,
                (state.generation, frame.map_or(0, |frame| frame.seq)),
            ) {
                let payload =
                    audio_payload(&state, frame, surface.page_clock, &surface.configuration);
                let proxy = self.proxy.clone();
                if surface
                    .webview
                    .evaluate_script_with_callback(
                        &format!(
                            "window.hertzWallpaper && window.hertzWallpaper.applyAudio({payload});"
                        ),
                        move |_| {
                            let _ = proxy.send_event(UserEvent::WallpaperAudioDelivered(0, token));
                        },
                    )
                    .is_err()
                {
                    self.wallpaper_audio_dispatch.acknowledge(0, token);
                    surface.eval_failures.fetch_add(1, Ordering::Relaxed);
                }
            }
        } else {
            self.wallpaper_audio_dispatch.prepare(0, None, (0, 0));
        }
        if let Some(surface) = self
            .preview
            .as_ref()
            .and_then(|preview| preview.surface.as_ref())
        {
            let target = (surface.first_frame_ready()
                && system_device(&surface.configuration).is_some())
            .then(|| format!("preview:{}", surface.binding.generation()));
            let frame = if preview_allowed { frame } else { None };
            if let Some(token) = self.wallpaper_audio_dispatch.prepare(
                1,
                target,
                (state.generation, frame.map_or(0, |frame| frame.seq)),
            ) {
                let payload =
                    audio_payload(&state, frame, surface.page_clock, &surface.configuration);
                let script = format!(
                    "window.hertzWallpaper && window.hertzWallpaper.applyAudio({payload});"
                );
                let proxy = self.proxy.clone();
                if surface
                    .webview
                    .evaluate_script_with_callback(&script, move |_| {
                        let _ = proxy.send_event(UserEvent::WallpaperAudioDelivered(1, token));
                    })
                    .is_err()
                {
                    self.wallpaper_audio_dispatch.acknowledge(1, token);
                }
            }
        } else {
            self.wallpaper_audio_dispatch.prepare(1, None, (0, 0));
        }
    }

    pub(super) fn wallpaper_audio_status(&self) -> serde_json::Value {
        let state = self.wallpaper_audio.snapshot();
        let mut value = serde_json::to_value(&state).unwrap_or_default();
        let desktop = self.desktop_audio_device();
        let preview = self.preview_audio_device();
        value["desktopConsumer"] = desktop.is_some().into();
        value["previewConsumer"] = preview
            .as_ref()
            .is_some_and(|preview| {
                desktop
                    .as_ref()
                    .is_none_or(|desktop| compatible(desktop, preview, &state))
            })
            .into();
        value["previewBlocked"] = preview
            .as_ref()
            .zip(desktop.as_ref())
            .is_some_and(|(preview, desktop)| !compatible(desktop, preview, &state))
            .into();
        value["frameAgeMs"] = state
            .frame
            .as_ref()
            .map(|frame| frame.captured_at.elapsed().as_millis() as u64)
            .into();
        value["sequence"] = state.frame.as_ref().map(|frame| frame.seq).into();
        value["peak"] = state
            .frame
            .as_ref()
            .map(|frame| frame.bands.iter().copied().fold(0.0f32, f32::max))
            .into();
        value
    }
}

fn audio_payload(
    state: &audio_service::Snapshot,
    frame: Option<&audio_service::Frame>,
    clock: Option<PageClock>,
    config: &config::WallpaperConfig,
) -> String {
    let now = Instant::now();
    serde_json::json!({
        "generation": state.generation,
        "sourceKey": match &config.audio_input {
            AudioInput::System { device: AudioDevice::Default, .. } => Some("default".to_owned()),
            AudioInput::System { device: AudioDevice::Fixed { id }, .. } => Some(format!("fixed:{id}")),
            _ => None,
        },
        "seq": frame.map_or(0, |frame| frame.seq),
        "bands": frame.map(|frame| frame.bands.as_slice()),
        "ageMs": frame.map(|frame| now.saturating_duration_since(frame.captured_at).as_millis() as u64),
        "pageDispatchMs": clock.map(|clock| clock.at(now)),
    }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_and_non_system_selections_never_demand_loopback() {
        let mut config = config::WallpaperConfig::default();
        assert!(system_device(&config).is_none());
        config.audio_input = AudioInput::System {
            device: AudioDevice::Default,
            gain: 1.,
            attack_ms: 40,
            release_ms: 250,
        };
        assert_eq!(system_device(&config), Some(AudioDevice::Default));
        config.main_mut().selection = crate::wallpaper::config::Selection::Package {
            work_key: "w".into(),
            package_hash: "a".repeat(64),
        };
        assert!(system_device(&config).is_none());
    }
    #[test]
    fn preview_compatibility_requires_same_resolved_endpoint() {
        let mut state = audio_service::Snapshot::default();
        let fixed = AudioDevice::Fixed { id: "a".into() };
        assert!(!compatible(&AudioDevice::Default, &fixed, &state));
        state
            .endpoints
            .push(crate::wallpaper::audio_devices::Endpoint {
                id: "a".into(),
                name: "speaker".into(),
                is_default: true,
            });
        assert!(compatible(&AudioDevice::Default, &fixed, &state));
        assert!(!compatible(
            &fixed,
            &AudioDevice::Fixed { id: "b".into() },
            &state
        ));
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    #[test]
    fn slow_pages_hold_one_frame_and_take_latest_after_ack() {
        let mut dispatch = Dispatch::default();
        let target = Some("page-1".into());
        let first = dispatch.prepare(0, target.clone(), (1, 1)).unwrap();
        for seq in 2..1000 {
            assert!(dispatch.prepare(0, target.clone(), (1, seq)).is_none());
        }
        // Other presentation has its own bounded slot.
        assert!(dispatch
            .prepare(1, Some("preview-1".into()), (1, 999))
            .is_some());
        dispatch.acknowledge(0, first);
        let latest = dispatch.prepare(0, target.clone(), (1, 999)).unwrap();
        dispatch.acknowledge(0, first);
        assert!(
            dispatch.prepare(0, target.clone(), (1, 1000)).is_none(),
            "stale completion cannot unlock a newer frame"
        );
        dispatch.invalidate();
        assert!(
            dispatch.prepare(0, target.clone(), (2, 0)).is_none(),
            "source invalidation preserves backpressure"
        );
        dispatch.acknowledge(0, latest);
        assert!(dispatch.prepare(0, target, (2, 0)).is_some());
    }
    #[test]
    fn controller_replacement_rejects_old_completion() {
        let mut dispatch = Dispatch::default();
        let old = dispatch.prepare(0, Some("page-1".into()), (1, 1)).unwrap();
        let next = dispatch.prepare(0, Some("page-2".into()), (1, 2)).unwrap();
        dispatch.acknowledge(0, old);
        assert!(dispatch.prepare(0, Some("page-2".into()), (1, 3)).is_none());
        dispatch.acknowledge(0, next);
        assert!(dispatch.prepare(0, Some("page-2".into()), (1, 3)).is_some());
    }
}
