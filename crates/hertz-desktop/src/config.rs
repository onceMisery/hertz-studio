// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 唯一的桌面配置。持久配置表达用户意图；窗口/来源运行事实另行查询。

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u32 = 2;
pub(crate) const MAX_PROFILES: usize = 8;
const MAX_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) revision: u64,
    pub(crate) launch_at_login: bool,
    pub(crate) active_profile: Option<Profile>,
    pub(crate) profiles: Vec<ProfileDomain>,
    pub(crate) lyrics: LyricsConfig,
    pub(crate) wallpaper: WallpaperConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileDomain {
    pub(crate) profile: Profile,
    pub(crate) lyrics: LyricsConfig,
    pub(crate) wallpaper: WallpaperConfig,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV2 {
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    active_profile: Option<Profile>,
    #[serde(default)]
    profiles: Vec<ProfileDomain>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV1 {
    #[allow(dead_code)]
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    active_profile: Option<Profile>,
    lyrics: LyricsConfig,
    #[serde(default)]
    wallpaper: WallpaperConfig,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Profile {
    pub(crate) data_dir: PathBuf,
    pub(crate) edition: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Layout {
    Single,
    Double,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Secondary {
    Next,
    Translation,
    Romanization,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WallpaperConfig {
    pub(crate) enabled: bool,
    pub(crate) fps: u8,
    pub(crate) music_response: bool,
    pub(crate) monitor: Option<String>,
    pub(crate) source: String,
    pub(crate) scene: String,
}

/// 壁纸运行时能直接渲染、且不依赖封面/歌词/频谱队列的场景。
/// 顺序就是设置页下拉的顺序；id 与 SpaceStagePure registry 一致。
pub(crate) const WALLPAPER_SCENES: &[(&str, &str)] = &[
    ("zodiac", "星座"),
    ("coast", "海岸公路"),
    ("butterfly-vortex", "蝶舞星涡"),
    ("phoenix-vortex", "凤凰涅槃"),
    ("reactor", "粒子反应堆"),
    ("particle-silk", "粒子绸带"),
    ("gravity-sphere", "引力星球"),
    ("warp-tunnel", "折跃隧道"),
    ("prism-galaxy", "棱镜星系"),
];

pub(crate) fn default_wallpaper_source() -> String {
    "follow".into()
}

pub(crate) fn default_wallpaper_scene() -> String {
    "zodiac".into()
}

pub(crate) fn wallpaper_scene_allowed(scene: &str) -> bool {
    WALLPAPER_SCENES.iter().any(|(id, _)| *id == scene)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LyricsConfig {
    pub(crate) enabled: bool,
    pub(crate) locked: bool,
    pub(crate) layout: Layout,
    pub(crate) secondary: Secondary,
    pub(crate) font_family: String,
    pub(crate) font_size: f64,
    pub(crate) font_weight: u16,
    pub(crate) sung_color: String,
    pub(crate) unsung_color: String,
    pub(crate) outline_color: String,
    pub(crate) outline_width: f64,
    pub(crate) opacity: f64,
    pub(crate) width: f64,
    pub(crate) anchor_x: f64,
    pub(crate) anchor_y: f64,
    pub(crate) monitor: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            revision: 1,
            launch_at_login: false,
            active_profile: None,
            profiles: Vec::new(),
            lyrics: LyricsConfig::default(),
            wallpaper: WallpaperConfig::default(),
        }
    }
}

impl Default for WallpaperConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            fps: 30,
            music_response: true,
            monitor: None,
            source: default_wallpaper_source(),
            scene: default_wallpaper_scene(),
        }
    }
}

impl Default for LyricsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            locked: false,
            layout: Layout::Double,
            secondary: Secondary::Next,
            font_family: "Segoe UI".into(),
            font_size: 32.0,
            font_weight: 600,
            sung_color: "#8fe3ff".into(),
            unsung_color: "#ffffff".into(),
            outline_color: "#000000".into(),
            outline_width: 2.0,
            opacity: 0.92,
            width: 900.0,
            anchor_x: 0.5,
            anchor_y: 0.84,
            monitor: None,
        }
    }
}

impl Config {
    pub(crate) fn sanitize(&mut self) {
        sanitize_lyrics(&mut self.lyrics);
        sanitize_wallpaper(&mut self.wallpaper);
        for domain in &mut self.profiles {
            sanitize_lyrics(&mut domain.lyrics);
            sanitize_wallpaper(&mut domain.wallpaper);
        }
    }

    fn domain_index(&self, profile: &Profile) -> Option<usize> {
        self.profiles
            .iter()
            .position(|domain| same_profile(&domain.profile, profile))
    }

    /// 把当前活动域写回该 profile 的存档。调用方保证不越过 profile 上限。
    fn store_active(&mut self) -> Result<()> {
        let Some(profile) = self.active_profile.clone() else {
            return Ok(());
        };
        if let Some(index) = self.domain_index(&profile) {
            self.profiles[index].lyrics = self.lyrics.clone();
            self.profiles[index].wallpaper = self.wallpaper.clone();
            return Ok(());
        }
        if self.profiles.len() >= MAX_PROFILES {
            bail!("桌面配置最多保存 {MAX_PROFILES} 个来源，请先整理 config.json");
        }
        self.profiles.push(ProfileDomain {
            profile,
            lyrics: self.lyrics.clone(),
            wallpaper: self.wallpaper.clone(),
        });
        Ok(())
    }

    /// 切换活动来源并在内存中换上目标 profile 自己的歌词/壁纸域。
    /// 只改内存；持久化与运行状态清理由调用方在保存成功后完成。
    pub(crate) fn activate_profile(&mut self, profile: Profile) -> Result<bool> {
        if self
            .active_profile
            .as_ref()
            .is_some_and(|active| same_profile(active, &profile))
        {
            return Ok(false);
        }
        let existing = self.domain_index(&profile);
        if existing.is_none() && self.profiles.len() >= MAX_PROFILES {
            bail!("桌面配置最多保存 {MAX_PROFILES} 个来源，请先整理 config.json");
        }
        self.store_active()?;
        if let Some(index) = existing {
            self.lyrics = self.profiles[index].lyrics.clone();
            self.wallpaper = self.profiles[index].wallpaper.clone();
        } else {
            // 首次绑定时沿用现有域（含 schema v1 迁移）；已绑定过来源后，
            // 新来源从默认域开始，不继承另一个 profile 的启用状态与样式。
            if self.active_profile.is_some() {
                self.lyrics = LyricsConfig::default();
                self.wallpaper = WallpaperConfig::default();
            }
            self.profiles.push(ProfileDomain {
                profile: profile.clone(),
                lyrics: self.lyrics.clone(),
                wallpaper: self.wallpaper.clone(),
            });
        }
        self.active_profile = Some(profile);
        Ok(true)
    }

    pub(crate) fn known_profiles(&self) -> Vec<Profile> {
        let mut output: Vec<Profile> = Vec::new();
        for domain in &self.profiles {
            if !output
                .iter()
                .any(|profile| same_profile(profile, &domain.profile))
            {
                output.push(domain.profile.clone());
            }
        }
        if let Some(active) = self.active_profile.as_ref() {
            if !output.iter().any(|profile| same_profile(profile, active)) {
                output.insert(0, active.clone());
            }
        }
        output
    }
}

fn sanitize_lyrics(lyrics: &mut LyricsConfig) {
    lyrics.font_size = lyrics.font_size.clamp(18.0, 72.0);
    lyrics.font_weight = match lyrics.font_weight {
        400 | 500 | 600 | 700 | 800 => lyrics.font_weight,
        _ => 600,
    };
    for color in [
        &mut lyrics.sung_color,
        &mut lyrics.unsung_color,
        &mut lyrics.outline_color,
    ] {
        if !valid_color(color) {
            *color = "#ffffff".into();
        }
    }
    lyrics.outline_width = lyrics.outline_width.clamp(0.0, 6.0);
    lyrics.opacity = lyrics.opacity.clamp(0.25, 1.0);
    lyrics.width = lyrics.width.clamp(240.0, 2400.0);
    lyrics.anchor_x = lyrics.anchor_x.clamp(0.0, 1.0);
    lyrics.anchor_y = lyrics.anchor_y.clamp(0.0, 1.0);
    if lyrics.font_family.trim().is_empty() {
        lyrics.font_family = "Segoe UI".into();
    }
}

fn sanitize_wallpaper(wallpaper: &mut WallpaperConfig) {
    wallpaper.fps = wallpaper.fps.clamp(15, 60);
    wallpaper.monitor = wallpaper
        .monitor
        .take()
        .map(|monitor| monitor.trim().to_string())
        .filter(|monitor| !monitor.is_empty());
    if !matches!(wallpaper.source.as_str(), "follow" | "fixed") {
        wallpaper.source = default_wallpaper_source();
    }
    if !wallpaper_scene_allowed(&wallpaper.scene) {
        wallpaper.scene = default_wallpaper_scene();
    }
}

pub(crate) fn valid_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

pub(crate) fn same_profile(left: &Profile, right: &Profile) -> bool {
    left.edition.eq_ignore_ascii_case(&right.edition)
        && normalized_path(&left.data_dir).eq_ignore_ascii_case(&normalized_path(&right.data_dir))
}

fn normalized_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let trimmed = text.trim_end_matches('\\');
    if trimmed.len() < 3 {
        text
    } else {
        trimmed.to_string()
    }
}

/// 切换来源前解析目标：只接受已知发行版、绝对路径和存在的文件夹。
pub(crate) fn normalize_profile(profile: Profile) -> Result<Profile> {
    let edition = profile.edition.trim().to_ascii_lowercase();
    if !matches!(edition.as_str(), "full" | "standard" | "custom") {
        bail!("未知发行版：{}", profile.edition);
    }
    if !profile.data_dir.is_absolute() {
        bail!("数据目录必须是绝对路径");
    }
    let canonical = std::fs::canonicalize(&profile.data_dir)
        .with_context(|| format!("数据目录不可用：{}", profile.data_dir.display()))?;
    if !canonical.is_dir() {
        bail!("数据目录不是文件夹：{}", canonical.display());
    }
    let text = canonical.to_string_lossy().into_owned();
    let data_dir = if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        canonical
    };
    Ok(Profile { data_dir, edition })
}

pub(crate) fn base_dir() -> PathBuf {
    // 隔离测试/便携配置：显式目录优先于系统 LocalAppData。
    if let Some(dir) = std::env::var_os("HERTZ_DESKTOP_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Hertz")
        .join("Desktop")
}

pub(crate) fn config_path() -> PathBuf {
    base_dir().join("config.json")
}

pub(crate) fn log_path() -> PathBuf {
    base_dir().join("desktop.log")
}

pub(crate) fn webview_dir() -> PathBuf {
    base_dir().join("webview2")
}

fn parse_config(bytes: &[u8]) -> Result<(Config, bool)> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    match value.get("schemaVersion").and_then(|value| value.as_u64()) {
        Some(1) => {
            let stored: StoredConfigV1 = serde_json::from_value(value)?;
            let mut config = Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                active_profile: stored.active_profile.clone(),
                profiles: Vec::new(),
                lyrics: stored.lyrics,
                wallpaper: stored.wallpaper,
            };
            if let Some(profile) = stored.active_profile {
                config.profiles.push(ProfileDomain {
                    profile,
                    lyrics: config.lyrics.clone(),
                    wallpaper: config.wallpaper.clone(),
                });
            }
            config.sanitize();
            Ok((config, true))
        }
        Some(2) => {
            let stored: StoredConfigV2 = serde_json::from_value(value)?;
            if stored.profiles.len() > MAX_PROFILES {
                bail!(
                    "桌面配置包含 {} 个来源，超过上限 {MAX_PROFILES}",
                    stored.profiles.len()
                );
            }
            for (index, domain) in stored.profiles.iter().enumerate() {
                if stored.profiles[..index]
                    .iter()
                    .any(|other| same_profile(&other.profile, &domain.profile))
                {
                    bail!(
                        "桌面配置包含重复来源：{}",
                        domain.profile.data_dir.display()
                    );
                }
            }
            let mut config = Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                active_profile: stored.active_profile,
                profiles: stored.profiles,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
            };
            if let Some(active) = config.active_profile.clone() {
                match config.domain_index(&active) {
                    Some(index) => {
                        config.lyrics = config.profiles[index].lyrics.clone();
                        config.wallpaper = config.profiles[index].wallpaper.clone();
                    }
                    None => config.profiles.push(ProfileDomain {
                        profile: active,
                        lyrics: config.lyrics.clone(),
                        wallpaper: config.wallpaper.clone(),
                    }),
                }
            }
            config.sanitize();
            Ok((config, false))
        }
        other => bail!(
            "{} 的 schemaVersion={:?}，本组件只支持 {SCHEMA_VERSION}（文件未改动）",
            config_path().display(),
            other
        ),
    }
}

fn encode_config(config: &Config) -> Result<Vec<u8>> {
    let mut copy = config.clone();
    copy.store_active()?;
    let stored = StoredConfigV2 {
        schema_version: SCHEMA_VERSION,
        revision: copy.revision,
        launch_at_login: copy.launch_at_login,
        active_profile: copy.active_profile,
        profiles: copy.profiles,
    };
    let bytes = serde_json::to_vec_pretty(&stored)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!(
            "桌面配置超过 {} KiB 上限（{} 字节），未保存",
            MAX_CONFIG_BYTES / 1024,
            bytes.len()
        );
    }
    Ok(bytes)
}

pub(crate) fn load() -> Result<Config> {
    let path = config_path();
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = Config::default();
            save(&config)?;
            return Ok(config);
        }
        Err(error) => return Err(error).with_context(|| format!("读取 {}", path.display())),
    };
    let (config, migrated) = parse_config(&bytes)
        .with_context(|| format!("解析 {}（坏配置原样保留，未覆盖）", path.display()))?;
    // 没有 activeProfile 的 v1 配置还带着顶层域，先不要落盘：等首次绑定
    // 把它归入选中的 profile 后再写 v2，避免迁移时丢掉歌词/壁纸设置。
    if migrated && config.active_profile.is_some() {
        save(&config)
            .with_context(|| format!("迁移 {} 到 schema v{SCHEMA_VERSION}", path.display()))?;
    }
    Ok(config)
}

pub(crate) fn save(config: &Config) -> Result<()> {
    let dir = base_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("创建 {}", dir.display()))?;
    let path = config_path();
    let tmp = dir.join("config.json.tmp");
    let bytes = encode_config(config)?;
    std::fs::write(&tmp, bytes).with_context(|| format!("写入 {}", tmp.display()))?;
    crate::native::replace_file(&tmp, &path).with_context(|| format!("替换 {}", path.display()))?;
    Ok(())
}

/// 首次启动自动选一个 profile：只读两个规范数据目录，不扫描端口。
pub(crate) fn detect_profile() -> Option<Profile> {
    let mut candidates = Vec::new();
    for profile in detect_profiles() {
        let discovery = profile.data_dir.join("vmusicd.json");
        let Ok(meta) = std::fs::metadata(&discovery) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        candidates.push((modified, profile));
    }
    candidates
        .into_iter()
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, profile)| profile)
}

/// 已知的规范数据目录；不要求 discovery 存在，离线来源仍可被选择。
pub(crate) fn detect_profiles() -> Vec<Profile> {
    let Some(base) = dirs::data_local_dir() else {
        return Vec::new();
    };
    [
        ("full", "hertz-studio"),
        ("standard", "hertz-studio-standard"),
    ]
    .into_iter()
    .filter_map(|(edition, name)| {
        let data_dir = base.join(name);
        data_dir.is_dir().then(|| Profile {
            data_dir,
            edition: edition.into(),
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str) -> Profile {
        Profile {
            data_dir: PathBuf::from(format!(r"C:\profiles\{name}")),
            edition: "full".into(),
        }
    }

    #[test]
    fn v1_config_moves_domain_under_active_profile() {
        let lyrics = serde_json::to_value(LyricsConfig::default()).unwrap();
        let wallpaper = serde_json::to_value(WallpaperConfig::default()).unwrap();
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "revision": 7,
            "launchAtLogin": true,
            "activeProfile": { "dataDir": r"C:\profiles\a", "edition": "full" },
            "lyrics": lyrics,
            "wallpaper": wallpaper,
        });
        value["lyrics"]["fontSize"] = 44.0.into();
        value["wallpaper"]["fps"] = 60.into();
        let (config, migrated) = parse_config(value.to_string().as_bytes()).unwrap();
        assert!(migrated);
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(
            config.profiles[0].profile.data_dir,
            PathBuf::from(r"C:\profiles\a")
        );
        assert_eq!(config.profiles[0].lyrics.font_size, 44.0);
        assert_eq!(config.lyrics.font_size, 44.0);
        let encoded = encode_config(&config).unwrap();
        let encoded: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(encoded["schemaVersion"], 2);
        assert!(encoded.get("lyrics").is_none());
        assert_eq!(encoded["profiles"][0]["lyrics"]["fontSize"], 44.0);
    }

    #[test]
    fn v1_without_active_profile_keeps_domain_until_binding() {
        let lyrics = serde_json::to_value(LyricsConfig::default()).unwrap();
        let wallpaper = serde_json::to_value(WallpaperConfig::default()).unwrap();
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "revision": 5,
            "launchAtLogin": false,
            "activeProfile": null,
            "lyrics": lyrics,
            "wallpaper": wallpaper,
        });
        value["lyrics"]["fontSize"] = 44.0.into();
        value["wallpaper"]["fps"] = 60.into();
        let (mut config, migrated) = parse_config(value.to_string().as_bytes()).unwrap();
        assert!(migrated);
        assert!(config.profiles.is_empty());
        assert_eq!(config.lyrics.font_size, 44.0);
        config.activate_profile(profile("a")).unwrap();
        let encoded = encode_config(&config).unwrap();
        let (loaded, migrated_again) = parse_config(&encoded).unwrap();
        assert!(!migrated_again);
        assert_eq!(loaded.lyrics.font_size, 44.0);
        assert_eq!(loaded.wallpaper.fps, 60);
        assert_eq!(loaded.profiles.len(), 1);
    }

    #[test]
    fn switching_profiles_keeps_independent_domains() {
        let a = profile("a");
        let b = profile("b");
        let mut config = Config::default();
        assert!(config.activate_profile(a.clone()).unwrap());
        config.lyrics.font_size = 44.0;
        config.wallpaper.fps = 60;
        config.wallpaper.enabled = true;

        assert!(config.activate_profile(b.clone()).unwrap());
        assert_eq!(config.lyrics.font_size, 32.0);
        assert!(!config.wallpaper.enabled);
        config.lyrics.font_size = 20.0;

        assert!(config.activate_profile(a.clone()).unwrap());
        assert_eq!(config.lyrics.font_size, 44.0);
        assert_eq!(config.wallpaper.fps, 60);
        assert!(config.wallpaper.enabled);
        assert!(!config.activate_profile(a).unwrap());

        let encoded = encode_config(&config).unwrap();
        let (loaded, migrated) = parse_config(&encoded).unwrap();
        assert!(!migrated);
        assert_eq!(loaded.lyrics.font_size, 44.0);
        assert_eq!(loaded.profiles.len(), 2);
        assert_eq!(
            loaded.active_profile.as_ref().unwrap().data_dir,
            PathBuf::from(r"C:\profiles\a")
        );
    }

    #[test]
    fn profile_cap_rejects_new_source() {
        let mut config = Config::default();
        for index in 0..MAX_PROFILES {
            config
                .activate_profile(profile(&format!("p{index}")))
                .unwrap();
        }
        let error = config.activate_profile(profile("overflow")).unwrap_err();
        assert!(error.to_string().contains("最多保存"));
        assert_eq!(config.profiles.len(), MAX_PROFILES);
    }

    #[test]
    fn profile_match_is_case_and_separator_insensitive() {
        let left = Profile {
            data_dir: PathBuf::from(r"C:\Users\Miracle\hertz-studio"),
            edition: "FULL".into(),
        };
        let right = Profile {
            data_dir: PathBuf::from("c:/users/miracle/hertz-studio/"),
            edition: "full".into(),
        };
        assert!(same_profile(&left, &right));
    }

    #[test]
    fn unsupported_schema_is_rejected() {
        let value = serde_json::json!({ "schemaVersion": 99 });
        assert!(parse_config(value.to_string().as_bytes()).is_err());
    }

    #[test]
    fn wallpaper_scene_defaults_to_follow_and_sanitizes_unknown_values() {
        let mut value = serde_json::to_value(WallpaperConfig::default()).unwrap();
        assert_eq!(value["source"], "follow");
        assert_eq!(value["scene"], "zodiac");
        value.as_object_mut().unwrap().remove("source");
        value.as_object_mut().unwrap().remove("scene");
        let defaults: WallpaperConfig = serde_json::from_value(value).unwrap();
        assert_eq!(defaults.source, "follow");
        assert_eq!(defaults.scene, "zodiac");

        let mut invalid: WallpaperConfig = serde_json::from_value(serde_json::json!({
            "enabled": false,
            "fps": 30,
            "musicResponse": true,
            "source": "something",
            "scene": "cover-sphere"
        }))
        .unwrap();
        sanitize_wallpaper(&mut invalid);
        assert_eq!(invalid.source, "follow");
        assert_eq!(invalid.scene, "zodiac");
        assert!(wallpaper_scene_allowed("butterfly-vortex"));
        assert!(!wallpaper_scene_allowed("cover-sphere"));
    }
}
