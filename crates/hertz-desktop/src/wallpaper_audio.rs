// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! All desktops and the settings preview share one loopback owner. A preview cannot
//! change the endpoint underneath an active desktop; Hertz metadata stays on its own feed.
use super::*;
use crate::wallpaper::{
    audio_service,
    config::{AudioDevice, AudioInput},
};

const DESKTOP_SINKS: usize = 4;
const PREVIEW_SLOT: usize = DESKTOP_SINKS;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    Desktop { key: String, generation: u64 },
    Preview { generation: u64 },
}

#[derive(Default)]
struct Sink {
    target: Option<Target>,
    pending: Option<u64>,
    delivered: Option<(u64, u64)>,
}
#[derive(Default)]
pub(super) struct Dispatch {
    sinks: [Sink; DESKTOP_SINKS + 1],
    next: u64,
}
impl Dispatch {
    fn retain_targets<'a>(&mut self, targets: impl IntoIterator<Item = &'a Target>) {
        let mut retained = [false; DESKTOP_SINKS + 1];
        for target in targets {
            if let Some(slot) = self
                .sinks
                .iter()
                .position(|sink| sink.target.as_ref() == Some(target))
            {
                retained[slot] = true;
            }
        }
        for (sink, retained) in self.sinks.iter_mut().zip(retained) {
            if !retained {
                *sink = Sink::default();
            }
        }
    }

    fn prepare(&mut self, target: &Target, key: (u64, u64)) -> Option<(usize, u64)> {
        let slots = match target {
            Target::Desktop { .. } => 0..DESKTOP_SINKS,
            Target::Preview { .. } => PREVIEW_SLOT..PREVIEW_SLOT + 1,
        };
        // Existing identities keep their slot even when a registry insertion changes order.
        let slot = slots
            .clone()
            .find(|&slot| self.sinks[slot].target.as_ref() == Some(target))
            .or_else(|| {
                slots
                    .clone()
                    .find(|&slot| self.sinks[slot].target.is_none())
            })?;
        let sink = &mut self.sinks[slot];
        if sink.target.is_none() {
            *sink = Sink {
                target: Some(target.clone()),
                ..Default::default()
            };
        }
        if sink.pending.is_some() || sink.delivered == Some(key) {
            return None;
        }
        // Tokens never repeat when a missing target's slot is reused. Exhaustion fails closed.
        self.next = self.next.checked_add(1)?;
        sink.pending = Some(self.next);
        sink.delivered = Some(key);
        Some((slot, self.next))
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

fn surface_system_device(surface: &WallpaperSurface) -> Option<AudioDevice> {
    if surface.runtime_builtin.is_none() || surface.static_poster {
        return None;
    }
    match &surface.configuration.audio_input {
        AudioInput::System { device, .. } => Some(device.clone()),
        _ => None,
    }
}

fn compatible(a: &AudioDevice, b: &AudioDevice, state: &audio_service::Snapshot) -> bool {
    if a == b {
        return true;
    }
    match (resolved_device(a, state), resolved_device(b, state)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn resolved_device<'a>(
    device: &'a AudioDevice,
    state: &'a audio_service::Snapshot,
) -> Option<&'a str> {
    match device {
        AudioDevice::Default => state
            .endpoints
            .iter()
            .find(|item| item.is_default)
            .map(|item| item.id.as_str()),
        AudioDevice::Fixed { id } => Some(id.as_str()),
    }
}

fn select_demand(
    desktops: &[AudioDevice],
    preview: Option<&AudioDevice>,
    requested: Option<&AudioDevice>,
) -> Option<AudioDevice> {
    // Preserve an existing desktop choice across target reorder/add/remove. Exact selection
    // matters: Default must keep following the default endpoint after a fixed consumer leaves.
    desktops
        .iter()
        .find(|device| Some(*device) == requested)
        .or_else(|| desktops.first())
        .or(preview)
        .cloned()
}

fn capture_frame<'a>(
    state: &'a audio_service::Snapshot,
    device: Option<&AudioDevice>,
) -> Option<&'a audio_service::Frame> {
    let device = device?;
    let requested = state.requested.as_ref()?;
    let capture = state.info.as_ref()?;
    // Endpoint discovery can update before the owner clears the previous generation. Check
    // the endpoint actually opened as well as the current selection to reject that old frame.
    if !state.capture_active
        || !compatible(device, requested, state)
        || resolved_device(device, state) != Some(capture.device_id.as_str())
    {
        return None;
    }
    state.frame.as_ref().filter(|frame| {
        frame.generation == state.generation && frame.captured_at.elapsed() < Duration::from_secs(1)
    })
}

impl App {
    fn desktop_audio_devices(&self) -> Vec<AudioDevice> {
        self.desktop
            .runtimes
            .values()
            .filter(|runtime| runtime.visible)
            .filter_map(|runtime| runtime.surface.as_ref().and_then(surface_system_device))
            .collect()
    }
    fn preview_audio_device(&self) -> Option<AudioDevice> {
        self.preview
            .as_ref()
            .filter(|preview| preview.lease_until > Instant::now())
            .and_then(|preview| preview.surface.as_ref())
            .filter(|surface| surface.first_frame_ready())
            .and_then(surface_system_device)
    }
    pub(super) fn validate_preview_audio(
        &self,
        config: &config::WallpaperConfig,
    ) -> Result<(), String> {
        let state = self.wallpaper_audio.snapshot();
        let desktop = select_demand(
            &self.desktop_audio_devices(),
            None,
            state.requested.as_ref(),
        );
        if let (Some(desktop), Some(preview)) = (desktop, system_device(config)) {
            if !compatible(&desktop, &preview, &state) {
                return Err(
                    "桌面正在使用其他系统音频设备；请选择相同设备，或先暂停桌面壁纸。".into(),
                );
            }
        }
        Ok(())
    }
    pub(super) fn sync_wallpaper_audio(&mut self) {
        let desktops = self.desktop_audio_devices();
        let preview = self.preview_audio_device();
        let demand = select_demand(
            &desktops,
            preview.as_ref(),
            self.wallpaper_audio.snapshot().requested.as_ref(),
        );
        self.wallpaper_audio.request(demand);
        let state = self.wallpaper_audio.snapshot();
        let consumers: Vec<_> = self
            .desktop
            .runtimes
            .iter()
            .filter_map(|(key, runtime)| {
                let surface = runtime.surface.as_ref().filter(|_| runtime.page_ready)?;
                let device = surface_system_device(surface)?;
                Some((
                    Target::Desktop {
                        key: key.clone(),
                        generation: surface.binding.generation(),
                    },
                    surface,
                    runtime.visible.then_some(device),
                ))
            })
            .chain(self.preview.as_ref().and_then(|preview| {
                let surface = preview
                    .surface
                    .as_ref()
                    .filter(|surface| surface.first_frame_ready())?;
                let device = surface_system_device(surface)?;
                Some((
                    Target::Preview {
                        generation: surface.binding.generation(),
                    },
                    surface,
                    (preview.lease_until > Instant::now()).then_some(device),
                ))
            }))
            .collect();
        self.wallpaper_audio_dispatch
            .retain_targets(consumers.iter().map(|(target, _, _)| target));
        for (target, surface, device) in consumers {
            let frame = capture_frame(&state, device.as_ref());
            if let Some((slot, token)) = self.wallpaper_audio_dispatch.prepare(
                &target,
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
                        let _ = proxy.send_event(UserEvent::WallpaperAudioDelivered(slot, token));
                    })
                    .is_err()
                {
                    self.wallpaper_audio_dispatch.acknowledge(slot, token);
                    if matches!(target, Target::Desktop { .. }) {
                        surface.eval_failures.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
    }

    pub(super) fn wallpaper_audio_status(&self) -> serde_json::Value {
        let state = self.wallpaper_audio.snapshot();
        let mut value = serde_json::to_value(&state).unwrap_or_default();
        let desktops = self.desktop_audio_devices();
        let desktop = select_demand(&desktops, None, state.requested.as_ref());
        let preview = self.preview_audio_device();
        value["desktopConsumer"] = (!desktops.is_empty()).into();
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

    #[test]
    fn desktop_demand_survives_reordering_and_takes_priority_over_preview() {
        let first = AudioDevice::Fixed { id: "a".into() };
        let second = AudioDevice::Fixed { id: "b".into() };
        let preview = AudioDevice::Fixed {
            id: "preview".into(),
        };
        assert_eq!(
            select_demand(
                &[second.clone(), first.clone()],
                Some(&preview),
                Some(&first)
            ),
            Some(first.clone())
        );
        assert_eq!(
            select_demand(std::slice::from_ref(&second), Some(&preview), Some(&first)),
            Some(second.clone())
        );
        assert_eq!(
            select_demand(
                std::slice::from_ref(&second),
                Some(&preview),
                Some(&preview)
            ),
            Some(second)
        );
        assert_eq!(
            select_demand(&[], Some(&preview), Some(&first)),
            Some(preview)
        );
        assert_eq!(select_demand(&[], None, Some(&first)), None);
        assert_eq!(
            select_demand(&[AudioDevice::Default], None, Some(&first)),
            Some(AudioDevice::Default),
            "a remaining Default consumer must resume following the default endpoint"
        );
    }

    fn capturing() -> audio_service::Snapshot {
        audio_service::Snapshot {
            generation: 7,
            requested: Some(AudioDevice::Default),
            capture_active: true,
            info: Some(crate::wallpaper::audio_capture::CaptureInfo {
                device_id: "a".into(),
                sample_rate: 48_000,
                channels: 2,
            }),
            endpoints: vec![crate::wallpaper::audio_devices::Endpoint {
                id: "a".into(),
                name: "speaker".into(),
                is_default: true,
            }],
            frame: Some(audio_service::Frame {
                generation: 7,
                seq: 11,
                bands: [0.5; crate::wallpaper::audio::BANDS],
                captured_at: Instant::now(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn multiple_desktops_and_preview_only_receive_their_compatible_capture() {
        let state = capturing();
        let same_endpoint = AudioDevice::Fixed { id: "a".into() };
        let other_endpoint = AudioDevice::Fixed { id: "b".into() };
        // Four desktops (including one paused) and the preview share a single snapshot.
        let consumers = [
            Some(&AudioDevice::Default),
            Some(&same_endpoint),
            Some(&other_endpoint),
            None,
            Some(&same_endpoint),
        ];
        let sequences =
            consumers.map(|device| capture_frame(&state, device).map(|frame| frame.seq));
        assert_eq!(sequences, [Some(11), Some(11), None, None, Some(11)]);

        let config = config::WallpaperConfig {
            audio_input: AudioInput::System {
                device: other_endpoint.clone(),
                gain: 1.,
                attack_ms: 40,
                release_ms: 250,
            },
            ..Default::default()
        };
        let payload: serde_json::Value = serde_json::from_str(&audio_payload(
            &state,
            capture_frame(&state, Some(&other_endpoint)),
            None,
            &config,
        ))
        .unwrap();
        assert!(payload["bands"].is_null());
        assert_eq!(payload["seq"], 0);
        assert_eq!(payload["sourceKey"], "fixed:b");
    }

    #[test]
    fn default_endpoint_changes_reject_the_old_capture_before_generation_advances() {
        let mut state = capturing();
        state.endpoints[0].id = "b".into();
        let old = AudioDevice::Fixed { id: "a".into() };
        let next = AudioDevice::Fixed { id: "b".into() };
        for device in [&AudioDevice::Default, &old, &next] {
            assert!(capture_frame(&state, Some(device)).is_none());
        }
        // A fixed capture remains usable by its fixed consumers when Default moves away.
        state.requested = Some(old.clone());
        assert!(capture_frame(&state, Some(&old)).is_some());
        assert!(capture_frame(&state, Some(&AudioDevice::Default)).is_none());
    }

    #[test]
    fn capture_requires_current_fresh_output_and_a_known_matching_endpoint() {
        let mut state = capturing();
        let selected = AudioDevice::Default;
        state.frame.as_mut().unwrap().generation -= 1;
        assert!(capture_frame(&state, Some(&selected)).is_none());
        state.frame.as_mut().unwrap().generation = state.generation;
        state.frame.as_mut().unwrap().captured_at = Instant::now() - Duration::from_secs(2);
        assert!(capture_frame(&state, Some(&selected)).is_none());
        state.frame.as_mut().unwrap().captured_at = Instant::now();
        state.info = None;
        assert!(capture_frame(&state, Some(&selected)).is_none());
        state = capturing();
        state.capture_active = false;
        assert!(capture_frame(&state, Some(&selected)).is_none());
        state = capturing();
        state.endpoints.clear();
        assert!(capture_frame(&state, Some(&selected)).is_none());
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    fn desktop(key: &str, generation: u64) -> Target {
        Target::Desktop {
            key: key.into(),
            generation,
        }
    }

    #[test]
    fn slow_pages_hold_one_frame_and_take_latest_after_ack() {
        let mut dispatch = Dispatch::default();
        let target = desktop("page", 1);
        let (slot, first) = dispatch.prepare(&target, (1, 1)).unwrap();
        for seq in 2..1000 {
            assert!(dispatch.prepare(&target, (1, seq)).is_none());
        }
        // Other presentation has its own bounded slot.
        assert_eq!(
            dispatch
                .prepare(&Target::Preview { generation: 2 }, (1, 999))
                .unwrap()
                .0,
            PREVIEW_SLOT
        );
        dispatch.acknowledge(slot, first);
        let (latest_slot, latest) = dispatch.prepare(&target, (1, 999)).unwrap();
        assert_eq!(latest_slot, slot);
        dispatch.acknowledge(slot, first);
        assert!(
            dispatch.prepare(&target, (1, 1000)).is_none(),
            "stale completion cannot unlock a newer frame"
        );
        dispatch.invalidate();
        assert!(
            dispatch.prepare(&target, (2, 0)).is_none(),
            "source invalidation preserves backpressure"
        );
        dispatch.acknowledge(slot, latest);
        assert!(dispatch.prepare(&target, (2, 0)).is_some());
    }

    #[test]
    fn controller_replacement_rejects_old_completion() {
        let mut dispatch = Dispatch::default();
        let (slot, old) = dispatch.prepare(&desktop("page", 1), (1, 1)).unwrap();
        let replacement = desktop("page", 2);
        dispatch.retain_targets([&replacement]);
        let (next_slot, next) = dispatch.prepare(&replacement, (1, 2)).unwrap();
        assert_eq!(next_slot, slot);
        dispatch.acknowledge(slot, old);
        assert!(dispatch.prepare(&replacement, (1, 3)).is_none());
        dispatch.acknowledge(slot, next);
        assert!(dispatch.prepare(&replacement, (1, 3)).is_some());
    }

    #[test]
    fn adding_and_reordering_targets_preserves_existing_pending_slots() {
        let mut dispatch = Dispatch::default();
        let first = desktop("b", 1);
        let second = desktop("c", 2);
        let earlier = desktop("a", 3);
        let (first_slot, first_token) = dispatch.prepare(&first, (1, 1)).unwrap();
        let (second_slot, second_token) = dispatch.prepare(&second, (1, 1)).unwrap();
        dispatch.retain_targets([&earlier, &second, &first]);
        let (earlier_slot, _) = dispatch.prepare(&earlier, (1, 2)).unwrap();
        assert_ne!(earlier_slot, first_slot);
        assert_ne!(earlier_slot, second_slot);
        assert!(dispatch.prepare(&second, (1, 2)).is_none());
        assert!(dispatch.prepare(&first, (1, 2)).is_none());
        dispatch.acknowledge(first_slot, first_token);
        assert_eq!(dispatch.prepare(&first, (1, 3)).unwrap().0, first_slot);
        dispatch.acknowledge(second_slot, second_token);
        assert_eq!(dispatch.prepare(&second, (1, 3)).unwrap().0, second_slot);
    }

    #[test]
    fn deleted_target_completion_cannot_clear_the_new_occupant() {
        let mut dispatch = Dispatch::default();
        let (old_slot, old_token) = dispatch.prepare(&desktop("old", 1), (1, 1)).unwrap();
        dispatch.retain_targets([]);
        let replacement = desktop("new", 2);
        let (next_slot, next_token) = dispatch.prepare(&replacement, (1, 1)).unwrap();
        assert_eq!(next_slot, old_slot);
        assert_ne!(next_token, old_token);
        dispatch.acknowledge(old_slot, old_token);
        assert!(dispatch.prepare(&replacement, (1, 2)).is_none());
        dispatch.acknowledge(next_slot, next_token);
        assert!(dispatch.prepare(&replacement, (1, 2)).is_some());
    }

    #[test]
    fn four_desktops_and_preview_have_five_independent_bounded_slots() {
        let mut dispatch = Dispatch::default();
        let desktops = [
            desktop("a", 1),
            desktop("b", 2),
            desktop("c", 3),
            desktop("d", 4),
        ];
        let preview = Target::Preview { generation: 5 };
        let mut acknowledgements = Vec::new();
        for (expected_slot, target) in desktops.iter().enumerate() {
            let receipt = dispatch.prepare(target, (1, 1)).unwrap();
            assert_eq!(receipt.0, expected_slot);
            acknowledgements.push(receipt);
        }
        assert!(dispatch.prepare(&desktop("overflow", 6), (1, 1)).is_none());
        assert_eq!(dispatch.prepare(&preview, (1, 1)).unwrap().0, PREVIEW_SLOT);
        for seq in 2..1000 {
            for target in desktops.iter().chain([&preview]) {
                assert!(dispatch.prepare(target, (1, seq)).is_none());
            }
        }
        for (target, (slot, token)) in desktops.iter().zip(acknowledgements) {
            dispatch.acknowledge(slot, token);
            assert_eq!(dispatch.prepare(target, (1, 1000)).unwrap().0, slot);
        }
        assert!(dispatch.prepare(&preview, (1, 1000)).is_none());
    }
}
