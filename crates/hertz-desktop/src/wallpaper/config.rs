// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! schema v5 壁纸意图。布局/选择/音频分型，旧扁平字段仅在迁移和旧管理入口解码。

use crate::config::{BatteryPolicy, WallpaperQuality};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 与原生前台进程查询共享上限，按 Windows UTF-16 路径字符计数。
pub(crate) const MAX_EXECUTABLE_PATH_CHARS: usize = 1024;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
        let mut executable_paths = std::collections::HashSet::new();
        for rule in &mut self.application_rules {
            rule.executable = normalize_executable_path(&rule.executable)?;
            if !executable_paths.insert(rule.executable.clone()) {
                bail!("同一可执行文件只能配置一条应用规则");
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
            if group.properties.iter().any(|(id, value)| {
                !hertz_wallpaper::valid_local_id(id)
                    || !(value.is_number() || value.is_boolean() || value.is_string())
            }) {
                bail!("公开属性需要有效 id 和标量值");
            }
            if !group.properties.is_empty()
                && !matches!(
                    group.selection,
                    Selection::Package { .. } | Selection::Playlist { .. }
                )
            {
                bail!("公开属性覆盖需要作品版本或轮播列表");
            }
        }
        super::display::requested_target_count(&self.groups)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if serde_json::to_vec(self)?.len() > 64 * 1024 {
            bail!("壁纸设置超过 64 KiB");
        }
        Ok(())
    }
}

/// 纯词法 Windows 可执行路径身份：配置与前台进程使用完全相同的比较规则。
/// 不访问磁盘，允许当前未安装/离线的应用；不展开环境变量、搜索 PATH 或
/// 跟随链接。仅接受盘符绝对路径/UNC 共享路径及等价的 Win32 verbatim 写法。
pub(crate) fn normalize_executable_path(input: &str) -> Result<String> {
    if input.chars().any(char::is_control) {
        bail!("应用规则路径不能包含控制字符");
    }
    let input = input.trim();
    if input.is_empty() || input.encode_utf16().count() > MAX_EXECUTABLE_PATH_CHARS {
        bail!("应用规则路径长度无效");
    }
    let normalized_slashes = input.replace('/', "\\").to_lowercase();
    let path = if let Some(verbatim) = normalized_slashes.strip_prefix(r"\\?\") {
        if let Some(unc) = verbatim.strip_prefix(r"unc\") {
            format!(r"\\{unc}")
        } else if drive_absolute(verbatim) {
            verbatim.to_owned()
        } else {
            bail!("应用规则不支持设备命名空间路径");
        }
    } else {
        normalized_slashes
    };
    // : 仅允许在盘符后；引号、通配符、重定向等不属于文件路径。
    // 空格仍可属于文件名；不解析命令行，必须与 OS 返回的完整路径相等。
    if path
        .chars()
        .any(|ch| matches!(ch, '"' | '<' | '>' | '|' | '?' | '*'))
        || path.ends_with('\\')
    {
        bail!("应用规则必须是完整可执行文件路径");
    }
    let (root, tail) = if drive_absolute(&path) {
        (path[..3].to_owned(), &path[3..])
    } else if let Some(unc) = path.strip_prefix(r"\\") {
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        let tail = parts.next().unwrap_or_default();
        if !path_component_valid(server) || !path_component_valid(share) {
            bail!("应用规则 UNC 路径必须包含服务器和共享名");
        }
        (format!(r"\\{server}\{share}\"), tail)
    } else {
        bail!("应用规则必须使用盘符绝对路径或 UNC 路径");
    };
    let mut components = Vec::new();
    for component in tail.split('\\') {
        match component {
            "" | "." => {}
            ".." => {
                if components.pop().is_none() {
                    bail!("应用规则路径不能超出盘符或共享根目录");
                }
            }
            component if path_component_valid(component) && !dos_device_name(component) => {
                components.push(component)
            }
            _ => bail!("应用规则路径包含无效文件名"),
        }
    }
    if components.is_empty() {
        bail!("应用规则必须指定可执行文件");
    }
    let normalized = format!("{root}{}", components.join("\\"));
    if normalized.encode_utf16().count() > MAX_EXECUTABLE_PATH_CHARS {
        bail!("应用规则路径长度无效");
    }
    Ok(normalized)
}

fn drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1..3] == *b":\\"
}

fn path_component_valid(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.ends_with(['.', ' '])
        && !component.contains(':')
}

fn dos_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default().trim_end();
    matches!(stem, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
        || ["com", "lpt"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// 从 registry 导出的同一份目录补默认值、校验类型与范围；不维护第二份场景参数表。
pub(crate) fn normalize_builtin(
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
    fn executable_path_identity_is_lexical_case_insensitive_and_absolute() {
        for (input, expected) in [
            (
                r" C:/Program Files/Player/./bin/../PLAYER.exe ",
                r"c:\program files\player\player.exe",
            ),
            (r"\\?\C:\Apps\Player.EXE", r"c:\apps\player.exe"),
            (
                r"\\Server\Share\Apps\..\PLAYER.exe",
                r"\\server\share\player.exe",
            ),
            (
                r"\\?\UNC\Server\Share\Apps\Player.exe",
                r"\\server\share\apps\player.exe",
            ),
            (r"//Server/Share/Player.exe", r"\\server\share\player.exe"),
            (r"D:\尚未安装\播放器.exe", r"d:\尚未安装\播放器.exe"),
            (
                r"C:\Apps\Executable Without Extension",
                r"c:\apps\executable without extension",
            ),
            (r"C:\Apps\player.bin", r"c:\apps\player.bin"),
        ] {
            let normalized = normalize_executable_path(input).unwrap();
            assert_eq!(normalized, expected, "{input}");
            assert_eq!(normalize_executable_path(&normalized).unwrap(), normalized);
        }
    }

    #[test]
    fn executable_path_rejects_relative_commands_devices_and_ambiguous_names() {
        for input in [
            "",
            "   ",
            "player.exe",
            r"C:player.exe",
            r"\Apps\player.exe",
            r"%ProgramFiles%\Player\player.exe",
            r#""C:\Apps\Player.exe" --fullscreen"#,
            r#"C:\Apps\"Player.exe"#,
            r"C:\Apps\Player.exe | other.exe",
            r"C:\Apps\*.exe",
            r"C:\Apps\Player.exe:stream",
            r"C:\Apps\Player.exe \\other.exe",
            r"C:\Apps.\Player.exe",
            r"C:\..\Player.exe",
            r"C:\",
            r"\\server",
            r"\\server\share",
            r"\\server\share\..\Player.exe",
            r"\\.\C:\Player.exe",
            r"\??\C:\Player.exe",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\Player.exe",
            r"\\?\Volume{abc}\Player.exe",
            r"C:\NUL",
            r"C:\con.exe",
            r"C:\LPT1\Player.exe",
            r"C:\COM¹.exe",
            "C:\\Apps\\Player\n.exe",
            "\tC:\\Apps\\Player.exe",
        ] {
            assert!(normalize_executable_path(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn executable_path_length_limit_uses_windows_characters_and_does_not_truncate() {
        let path = format!("C:\\{}", "界".repeat(MAX_EXECUTABLE_PATH_CHARS - 3));
        assert_eq!(
            normalize_executable_path(&path)
                .unwrap()
                .encode_utf16()
                .count(),
            MAX_EXECUTABLE_PATH_CHARS
        );
        assert!(normalize_executable_path(&format!("{path}x")).is_err());
        let path = format!("C:\\{}x", "😀".repeat((MAX_EXECUTABLE_PATH_CHARS - 4) / 2));
        assert_eq!(
            normalize_executable_path(&path)
                .unwrap()
                .encode_utf16()
                .count(),
            MAX_EXECUTABLE_PATH_CHARS
        );
        assert!(normalize_executable_path(&format!("{path}x")).is_err());
    }

    #[test]
    fn rules_normalize_once_and_duplicate_identity_is_rejected_for_any_action() {
        let mut config = WallpaperConfig {
            application_rules: vec![ApplicationRule {
                executable: r" C:/Apps/Player/../PLAYER.exe ".into(),
                action: RuleAction::Pause,
            }],
            ..Default::default()
        };
        config.normalize().unwrap();
        assert_eq!(
            config.application_rules[0].executable,
            r"c:\apps\player.exe"
        );
        for action in [RuleAction::Pause, RuleAction::Stop] {
            let mut duplicate = config.clone();
            duplicate.application_rules.push(ApplicationRule {
                executable: r"\\?\C:\APPS\PLAYER.exe".into(),
                action,
            });
            assert!(duplicate.normalize().is_err());
            assert_eq!(duplicate.application_rules.len(), 2);
        }
        config.application_rules.push(ApplicationRule {
            executable: r"D:\Other\player.exe".into(),
            action: RuleAction::Stop,
        });
        config.normalize().unwrap();
    }

    #[test]
    fn rule_count_limit_and_total_config_limit_reject_without_truncation() {
        let mut config = WallpaperConfig {
            application_rules: (0..32)
                .map(|index| ApplicationRule {
                    executable: format!(r"C:\Apps\Player{index}.exe"),
                    action: RuleAction::Pause,
                })
                .collect(),
            ..Default::default()
        };
        config.normalize().unwrap();
        config.application_rules.push(ApplicationRule {
            executable: r"C:\Apps\Player32.exe".into(),
            action: RuleAction::Stop,
        });
        assert!(config.normalize().is_err());
        assert_eq!(config.application_rules.len(), 33);

        let mut config = WallpaperConfig::default();
        config.main_mut().selection = Selection::Package {
            work_key: "size-boundary".into(),
            package_hash: "a".repeat(64),
        };
        config
            .main_mut()
            .properties
            .insert("large".into(), Value::String("x".repeat(64 * 1024)));
        assert!(config.normalize().is_err());
        assert_eq!(
            config.main().properties["large"].as_str().unwrap().len(),
            64 * 1024
        );
    }

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
