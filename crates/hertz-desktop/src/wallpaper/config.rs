// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! schema v5 壁纸意图。布局/选择/音频分型，旧扁平字段仅在迁移和旧管理入口解码。

use crate::config::{BatteryPolicy, WallpaperQuality};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WallpaperConfig {
    pub enabled: bool,
    pub audio_input: AudioInput,
    pub battery_policy: BatteryPolicy,
    pub pause_on_fullscreen: bool,
    pub pause_on_maximized: bool,
    pub application_rules: Vec<ApplicationRule>,
    pub groups: Vec<WallpaperGroup>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AudioInput {
    None,
    Hertz {
        gain: f64,
        #[serde(rename = "attackMs")]
        attack_ms: u32,
        #[serde(rename = "releaseMs")]
        release_ms: u32,
    },
    System {
        device: AudioDevice,
        gain: f64,
        #[serde(rename = "attackMs")]
        attack_ms: u32,
        #[serde(rename = "releaseMs")]
        release_ms: u32,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AudioDevice {
    Default,
    Fixed { id: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApplicationRule {
    pub executable: String,
    pub action: RuleAction,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RuleAction {
    Pause,
    Stop,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LayoutMode {
    Single,
    Mirror,
    Span,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum DisplaySelection {
    Primary,
    Fixed {
        #[serde(rename = "displayId")]
        display_id: String,
    },
    Unresolved {
        #[serde(rename = "legacyName")]
        legacy_name: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WallpaperGroup {
    pub id: String,
    pub mode: LayoutMode,
    pub displays: Vec<DisplaySelection>,
    pub selection: Selection,
    pub presentation: Presentation,
    pub properties: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Selection {
    Builtin {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "stateVersion")]
        state_version: u32,
        params: Map<String, Value>,
    },
    FollowHertz {
        #[serde(rename = "idleBuiltin")]
        idle_builtin: BuiltinState,
    },
    Package {
        #[serde(rename = "workKey")]
        work_key: String,
        #[serde(rename = "packageHash")]
        package_hash: String,
    },
    Playlist {
        #[serde(rename = "playlistId")]
        playlist_id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BuiltinState {
    pub scene_id: String,
    pub state_version: u32,
    pub params: Map<String, Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Fit {
    Cover,
    Contain,
    Stretch,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Presentation {
    pub fps: u8,
    pub quality: WallpaperQuality,
    pub brightness: f64,
    pub motion: f64,
    pub fit: Fit,
    pub pointer: bool,
}
impl Default for Presentation {
    fn default() -> Self {
        Self {
            fps: 30,
            quality: WallpaperQuality::Low,
            brightness: 1.,
            motion: 1.,
            fit: Fit::Cover,
            pointer: false,
        }
    }
}
impl Default for WallpaperConfig {
    fn default() -> Self {
        let mut config = Self {
            enabled: false,
            audio_input: AudioInput::Hertz {
                gain: 1.,
                attack_ms: 40,
                release_ms: 250,
            },
            battery_policy: BatteryPolicy::Pause,
            pause_on_fullscreen: true,
            pause_on_maximized: false,
            application_rules: vec![],
            groups: vec![WallpaperGroup {
                id: "main".into(),
                mode: LayoutMode::Single,
                displays: vec![DisplaySelection::Primary],
                selection: Selection::FollowHertz {
                    idle_builtin: BuiltinState {
                        scene_id: "zodiac".into(),
                        state_version: 1,
                        params: Map::new(),
                    },
                },
                presentation: Presentation::default(),
                properties: Map::new(),
            }],
        };
        config.normalize().expect("default wallpaper config");
        config
    }
}
impl WallpaperConfig {
    pub(crate) fn main(&self) -> &WallpaperGroup {
        &self.groups[0]
    }
    pub(crate) fn main_mut(&mut self) -> &mut WallpaperGroup {
        &mut self.groups[0]
    }
    /// 删除保护：任一显示组仍固定引用该作品或该包时不删库/不删包。
    pub(crate) fn references_package(
        &self,
        work_key: Option<&str>,
        package_hash: Option<&str>,
    ) -> bool {
        self.groups.iter().any(|group| match &group.selection {
            Selection::Package {
                work_key: selected_work,
                package_hash: selected_package,
            } => {
                work_key.is_some_and(|key| key == selected_work)
                    || package_hash.is_some_and(|hash| hash == selected_package)
            }
            _ => false,
        })
    }
    pub(crate) fn presentation(&self) -> &Presentation {
        &self.main().presentation
    }
    pub(crate) fn follows_hertz(&self) -> bool {
        matches!(self.main().selection, Selection::FollowHertz { .. })
    }
    pub(crate) fn builtin(&self) -> Option<BuiltinState> {
        match &self.main().selection {
            Selection::Builtin {
                scene_id,
                state_version,
                params,
            } => Some(BuiltinState {
                scene_id: scene_id.clone(),
                state_version: *state_version,
                params: params.clone(),
            }),
            Selection::FollowHertz { idle_builtin } => Some(idle_builtin.clone()),
            _ => None,
        }
    }
    pub(crate) fn responds_to_hertz(&self) -> bool {
        matches!(self.audio_input, AudioInput::Hertz { .. })
    }
    pub(crate) fn normalize(&mut self) -> Result<()> {
        if !(1..=4).contains(&self.groups.len()) || self.application_rules.len() > 32 {
            bail!("壁纸最多 4 个显示组和 32 条应用规则");
        }
        match &self.audio_input {
            AudioInput::None => {}
            AudioInput::Hertz {
                gain,
                attack_ms,
                release_ms,
            }
            | AudioInput::System {
                gain,
                attack_ms,
                release_ms,
                ..
            } => {
                if !gain.is_finite()
                    || !(0.0..=4.0).contains(gain)
                    || *attack_ms > 5000
                    || *release_ms > 10000
                {
                    bail!("音频增益或平滑时长超出范围");
                }
            }
        }
        if let AudioInput::System {
            device: AudioDevice::Fixed { id },
            ..
        } = &self.audio_input
        {
            if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
                bail!("音频设备身份无效");
            }
        }
        for rule in &self.application_rules {
            if rule.executable.is_empty()
                || rule.executable.len() > 1024
                || rule.executable.chars().any(char::is_control)
            {
                bail!("应用规则路径无效");
            }
        }
        let mut ids = std::collections::HashSet::new();
        let mut displays = std::collections::HashSet::new();
        for group in &mut self.groups {
            if !id_valid(&group.id) || !ids.insert(group.id.clone()) {
                bail!("显示组 id 无效或重复");
            }
            if group.displays.is_empty()
                || group.displays.len() > 4
                || (group.mode == LayoutMode::Single && group.displays.len() != 1)
            {
                bail!("显示组的屏幕数量无效");
            }
            for display in &group.displays {
                let key = match display {
                    DisplaySelection::Primary => "primary".into(),
                    DisplaySelection::Fixed { display_id } => {
                        if display_id.is_empty()
                            || display_id.len() > 256
                            || display_id.trim() != display_id
                            || display_id.chars().any(char::is_control)
                        {
                            bail!("显示器身份无效");
                        }
                        format!("fixed:{display_id}")
                    }
                    DisplaySelection::Unresolved { legacy_name } => {
                        if legacy_name.is_empty() || legacy_name.len() > 256 {
                            bail!("待认领显示器名称无效");
                        }
                        format!("legacy:{legacy_name}")
                    }
                };
                if !displays.insert(key) {
                    bail!("同一显示器不能属于两个组");
                }
            }
            let presentation = &group.presentation;
            if !matches!(presentation.fps, 15 | 30 | 60)
                || !presentation.brightness.is_finite()
                || !(0.25..=1.).contains(&presentation.brightness)
                || !presentation.motion.is_finite()
                || !(0.0..=1.).contains(&presentation.motion)
            {
                bail!("帧率、亮度或运动强度超出范围");
            }
            match &mut group.selection {
                Selection::Builtin {
                    scene_id,
                    state_version,
                    params,
                } => normalize_builtin(scene_id, *state_version, params)?,
                Selection::FollowHertz { idle_builtin } => normalize_builtin(
                    &idle_builtin.scene_id,
                    idle_builtin.state_version,
                    &mut idle_builtin.params,
                )?,
                Selection::Package {
                    work_key,
                    package_hash,
                } => {
                    if !id_valid(work_key) || !hertz_wallpaper::valid_sha256_hex(package_hash) {
                        bail!("作品引用无效");
                    }
                }
                Selection::Playlist { playlist_id } => {
                    if !id_valid(playlist_id) {
                        bail!("轮播列表身份无效");
                    }
                }
            }
            if group.properties.len() > 64 {
                bail!("公开属性最多 64 项");
            }
        }
        if serde_json::to_vec(self)?.len() > 64 * 1024 {
            bail!("壁纸设置超过 64 KiB");
        }
        Ok(())
    }
}
fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// 从 registry 导出的同一份目录补默认值、校验类型与范围；不维护第二份场景参数表。
pub(super) fn normalize_builtin(
    id: &str,
    version: u32,
    params: &mut Map<String, Value>,
) -> Result<()> {
    if !crate::config::wallpaper_scene_allowed(id) {
        bail!("场景不具备桌面资格");
    }
    let scene = hertz_wallpaper::catalog()
        .scene(id)
        .ok_or_else(|| anyhow::anyhow!("场景不存在"))?;
    if scene["stateVersion"].as_u64() != Some(u64::from(version)) {
        bail!("场景状态版本不匹配");
    }
    let schema = scene["params"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("场景参数合同无效"))?;
    if params.keys().any(|key| !schema.contains_key(key)) {
        bail!("场景包含未知参数");
    }
    for (key, spec) in schema {
        let value = params.get(key).unwrap_or(&spec["default"]);
        let valid = match spec["type"].as_str() {
            Some("number") => value.as_f64().is_some_and(|n| {
                n.is_finite()
                    && n >= spec["min"].as_f64().unwrap()
                    && n <= spec["max"].as_f64().unwrap()
            }),
            Some("boolean") => value.is_boolean(),
            Some("select") => spec["options"].as_array().is_some_and(|options| {
                options.iter().any(|option| {
                    if option.is_object() {
                        &option["value"] == value
                    } else {
                        option == value
                    }
                })
            }),
            Some("color") => value.as_str().is_some_and(|s| {
                s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
            }),
            Some("string") => value.as_str().is_some_and(|s| {
                s.encode_utf16().count() as u64 <= spec["maxLength"].as_u64().unwrap_or(256)
            }),
            _ => false,
        };
        if !valid {
            bail!("场景参数 {key} 无效");
        }
        params.insert(key.clone(), value.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_defaults_come_from_registry_and_unknown_or_invalid_params_are_rejected() {
        let mut config = WallpaperConfig::default();
        assert!(!config.builtin().unwrap().params.is_empty());
        let Selection::FollowHertz { idle_builtin } = &mut config.main_mut().selection else {
            unreachable!()
        };
        idle_builtin
            .params
            .insert("invented".into(), Value::Bool(true));
        assert!(config.normalize().is_err());
        let mut config = WallpaperConfig::default();
        config.main_mut().presentation.fps = 25;
        assert!(config.normalize().is_err());
    }
    #[test]
    fn user_params_remain_typed_and_numeric_limits_are_not_clamped() {
        let mut config = WallpaperConfig::default();
        config.main_mut().selection = Selection::Builtin {
            scene_id: "coast".into(),
            state_version: 1,
            params: Map::new(),
        };
        config.normalize().unwrap();
        let original = config.builtin().unwrap();
        assert!(!original.params.is_empty());
        let scene = hertz_wallpaper::catalog().scene("coast").unwrap();
        let (key, spec) = scene["params"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, spec)| spec["type"] == "number")
            .unwrap();
        let Selection::Builtin { params, .. } = &mut config.main_mut().selection else {
            unreachable!()
        };
        params.insert(
            key.clone(),
            serde_json::json!(spec["max"].as_f64().unwrap() + 1.0),
        );
        assert!(config.normalize().is_err());
        let mut config = WallpaperConfig {
            audio_input: AudioInput::System {
                device: AudioDevice::Fixed { id: String::new() },
                gain: 1.,
                attack_ms: 40,
                release_ms: 250,
            },
            ..Default::default()
        };
        assert!(config.normalize().is_err());
    }

    #[test]
    fn groups_bound_identity_and_references_without_accepting_legacy_fields() {
        let config = WallpaperConfig::default();
        let mut value = serde_json::to_value(&config).unwrap();
        value["source"] = "fixed".into();
        assert!(serde_json::from_value::<WallpaperConfig>(value).is_err());
        let mut invalid = config.clone();
        invalid.groups.push(invalid.main().clone());
        assert!(invalid.normalize().is_err());
        let mut invalid = config;
        invalid.main_mut().selection = Selection::Package {
            work_key: "work".into(),
            package_hash: "../path".into(),
        };
        assert!(invalid.normalize().is_err());
    }

    #[test]
    fn deletion_reference_check_covers_work_and_package_without_builtin_false_positives() {
        let mut config = WallpaperConfig::default();
        assert!(!config.references_package(Some("work"), None));
        assert!(!config.references_package(None, Some(&"a".repeat(64))));
        config.main_mut().selection = Selection::Package {
            work_key: "work".into(),
            package_hash: "a".repeat(64),
        };
        assert!(config.references_package(Some("work"), None));
        assert!(config.references_package(None, Some(&"a".repeat(64))));
        assert!(!config.references_package(Some("other"), None));
        assert!(!config.references_package(None, Some(&"b".repeat(64))));
    }
}
