// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 唯一的桌面配置。持久配置表达用户意图；窗口/来源运行事实另行查询。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u32 = 3;
static COMMIT_LOCK: Mutex<()> = Mutex::new(());
pub(crate) use hertz_desktop_ipc::Profile;
pub(crate) const MAX_PROFILES: usize = 8;
const MAX_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) revision: u64,
    pub(crate) launch_at_login: bool,
    pub(crate) active_profile: Option<Profile>,
    pub(crate) profiles: Vec<ProfileDomain>,
    pub(crate) unbound_standalone: Option<StandalonePreferences>,
    // Runtime view shown before binding; only edits to this view update legacy preferences.
    unbound_baseline: Option<StandalonePreferences>,
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StandalonePreferences {
    lyrics: LyricsConfig,
    wallpaper: WallpaperConfig,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV3 {
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    active_profile: Option<Profile>,
    #[serde(default)]
    profiles: Vec<ProfileDomain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unbound_standalone: Option<StandalonePreferences>,
}

// Untagged identities are accepted only while decoding legacy schemas.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyProfile {
    data_dir: String,
    edition: String,
}
impl LegacyProfile {
    fn migrate(self) -> Result<Profile> {
        let profile = Profile::Standalone {
            data_dir: self.data_dir,
            edition: self.edition.to_ascii_lowercase(),
        };
        profile.validate()?;
        Ok(profile)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDomain {
    profile: LegacyProfile,
    lyrics: LyricsConfig,
    wallpaper: WallpaperConfig,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV2 {
    #[allow(dead_code)]
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    active_profile: Option<LegacyProfile>,
    #[serde(default)]
    profiles: Vec<LegacyDomain>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV1 {
    #[allow(dead_code)]
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    active_profile: Option<LegacyProfile>,
    lyrics: LyricsConfig,
    #[serde(default)]
    wallpaper: WallpaperConfig,
}

pub(crate) fn standalone(data_dir: PathBuf, edition: &str) -> Profile {
    Profile::Standalone {
        data_dir: data_dir.to_string_lossy().into_owned(),
        edition: edition.into(),
    }
}
pub(crate) fn is_dbx(profile: &Profile) -> bool {
    matches!(profile, Profile::Dbx { .. })
}
// Compatibility at the old management boundary only; stored schema v3 is strict.
pub(crate) fn management_profile(value: serde_json::Value) -> Result<Profile> {
    if value.get("kind").is_some() {
        return Ok(serde_json::from_value(value)?);
    }
    serde_json::from_value::<LegacyProfile>(value)?.migrate()
}
pub(crate) fn next_revision(revision: u64) -> Result<u64> {
    revision
        .checked_add(1)
        .context("桌面配置 revision 已达上限，未保存")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Layout {
    Single,
    Double,
    Triple,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LyricTheme {
    #[default]
    Auto,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LyricSurface {
    #[default]
    Bare,
    Glass,
    Solid,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LyricAlign {
    Left,
    #[default]
    Center,
    Right,
}

fn default_true() -> bool {
    true
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
    #[serde(default)]
    pub(crate) theme: LyricTheme,
    #[serde(default)]
    pub(crate) surface: LyricSurface,
    #[serde(default)]
    pub(crate) align: LyricAlign,
    #[serde(default)]
    pub(crate) bilingual: bool,
    #[serde(default = "default_true")]
    pub(crate) karaoke: bool,
    #[serde(default)]
    pub(crate) readability_boost: bool,
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
            unbound_standalone: None,
            unbound_baseline: None,
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
            layout: Layout::Single,
            secondary: Secondary::Next,
            theme: LyricTheme::Auto,
            surface: LyricSurface::Bare,
            align: LyricAlign::Center,
            bilingual: false,
            karaoke: true,
            readability_boost: false,
            font_family: "Segoe UI".into(),
            font_size: 30.0,
            font_weight: 600,
            sung_color: "#ffffff".into(),
            unsung_color: "#ffffff".into(),
            outline_color: "#000000".into(),
            outline_width: 0.0,
            opacity: 1.0,
            width: 550.0,
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
        if let Some(unbound) = self.unbound_standalone.as_mut() {
            sanitize_lyrics(&mut unbound.lyrics);
            sanitize_wallpaper(&mut unbound.wallpaper);
        }
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
            let current = StandalonePreferences {
                lyrics: self.lyrics.clone(),
                wallpaper: self.wallpaper.clone(),
            };
            self.unbound_standalone =
                Some(match (&self.unbound_standalone, &self.unbound_baseline) {
                    (Some(saved), Some(baseline)) => {
                        let mut saved = serde_json::to_value(saved)?;
                        let baseline = serde_json::to_value(baseline)?;
                        let current = serde_json::to_value(&current)?;
                        for domain in ["lyrics", "wallpaper"] {
                            for (field, value) in current[domain].as_object().unwrap() {
                                if *value != baseline[domain][field] {
                                    saved[domain][field] = value.clone();
                                }
                            }
                        }
                        serde_json::from_value(saved)?
                    }
                    _ => current,
                });
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
            if !is_dbx(&profile) && self.unbound_standalone.is_some() {
                let unbound = self.unbound_standalone.take().unwrap();
                self.lyrics = unbound.lyrics;
                self.wallpaper = unbound.wallpaper;
            } else {
                self.lyrics = LyricsConfig::default();
                self.wallpaper = WallpaperConfig::default();
                // DBX authorization always starts with both persistent surfaces disabled.
                if is_dbx(&profile) {
                    self.lyrics.enabled = false;
                }
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
    // Existing directories use the shared Win32 final-path/invariant-case identity.
    // Offline persisted directories keep their lexical identity without losing the domain.
    let left = left.normalized().unwrap_or_else(|_| lexical_profile(left));
    let right = right
        .normalized()
        .unwrap_or_else(|_| lexical_profile(right));
    left == right
}
fn lexical_profile(profile: &Profile) -> Profile {
    let path = profile.data_dir().replace('/', "\\");
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!(r"\\{p}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(path);
    let mut normalized = PathBuf::new();
    for component in Path::new(&path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let data_dir = normalized
        .to_string_lossy()
        .trim_end_matches('\\')
        .to_lowercase();
    match profile {
        Profile::Standalone { edition, .. } => Profile::Standalone {
            edition: edition.to_ascii_lowercase(),
            data_dir,
        },
        Profile::Dbx {
            edition, plugin_id, ..
        } => Profile::Dbx {
            edition: edition.to_ascii_lowercase(),
            data_dir,
            plugin_id: plugin_id.clone(),
        },
    }
}
/// Explicit switches require an existing absolute directory; persisted offline sources do not.
pub(crate) fn normalize_profile(profile: Profile) -> Result<Profile> {
    profile.normalized().context("来源身份或数据目录不可用")
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
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("桌面配置超过 64 KiB 上限");
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let schema = value.get("schemaVersion").and_then(|value| value.as_u64());
    let mut config = match schema {
        Some(1) => {
            let stored: StoredConfigV1 = serde_json::from_value(value)?;
            let active = stored
                .active_profile
                .map(LegacyProfile::migrate)
                .transpose()?;
            let unbound = active.is_none().then(|| StandalonePreferences {
                lyrics: stored.lyrics.clone(),
                wallpaper: stored.wallpaper.clone(),
            });
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                active_profile: active.clone(),
                profiles: active
                    .into_iter()
                    .map(|profile| ProfileDomain {
                        profile,
                        lyrics: stored.lyrics.clone(),
                        wallpaper: stored.wallpaper.clone(),
                    })
                    .collect(),
                unbound_standalone: unbound,
                unbound_baseline: None,
                lyrics: stored.lyrics,
                wallpaper: stored.wallpaper,
            }
        }
        Some(2) => {
            let stored: StoredConfigV2 = serde_json::from_value(value)?;
            let profiles = stored
                .profiles
                .into_iter()
                .map(|domain| {
                    Ok(ProfileDomain {
                        profile: domain.profile.migrate()?,
                        lyrics: domain.lyrics,
                        wallpaper: domain.wallpaper,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                active_profile: stored
                    .active_profile
                    .map(LegacyProfile::migrate)
                    .transpose()?,
                profiles,
                unbound_standalone: None,
                unbound_baseline: None,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
            }
        }
        Some(3) => {
            let stored: StoredConfigV3 = serde_json::from_value(value)?;
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                active_profile: stored.active_profile,
                profiles: stored.profiles,
                unbound_standalone: stored.unbound_standalone,
                unbound_baseline: None,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
            }
        }
        other => bail!("不支持 schemaVersion={other:?}，文件未改动"),
    };
    validate_domains(&config)?;
    if let Some(active) = config.active_profile.clone() {
        active.validate()?;
        if let Some(index) = config.domain_index(&active) {
            config.lyrics = config.profiles[index].lyrics.clone();
            config.wallpaper = config.profiles[index].wallpaper.clone();
        } else {
            if is_dbx(&active) {
                config.lyrics = LyricsConfig::default();
                config.lyrics.enabled = false;
                config.wallpaper = WallpaperConfig::default();
            }
            config.profiles.push(ProfileDomain {
                profile: active,
                lyrics: config.lyrics.clone(),
                wallpaper: config.wallpaper.clone(),
            });
        }
    } else if config.unbound_standalone.is_some() {
        // Unbound preferences are not a candidate or a running surface.
        config.lyrics = LyricsConfig::default();
        config.lyrics.enabled = false;
        config.wallpaper = WallpaperConfig::default();
    }
    validate_domains(&config)?;
    config.sanitize();
    if config.active_profile.is_none() {
        config.unbound_baseline = Some(StandalonePreferences {
            lyrics: config.lyrics.clone(),
            wallpaper: config.wallpaper.clone(),
        });
    }
    let migrated = schema != Some(3);
    if migrated {
        config.revision = next_revision(config.revision)?;
    }
    Ok((config, migrated))
}
fn validate_domains(config: &Config) -> Result<()> {
    if config.profiles.len() > MAX_PROFILES {
        bail!("桌面配置来源超过上限 {MAX_PROFILES}");
    }
    for (index, domain) in config.profiles.iter().enumerate() {
        domain.profile.validate()?;
        if config.profiles[..index]
            .iter()
            .any(|other| same_profile(&other.profile, &domain.profile))
        {
            bail!("桌面配置包含重复来源");
        }
    }
    Ok(())
}
fn encode_config(config: &Config) -> Result<Vec<u8>> {
    let mut copy = config.clone();
    copy.store_active()?;
    validate_domains(&copy)?;
    if let Some(active) = copy.active_profile.as_ref() {
        active.validate()?;
    }
    let stored = StoredConfigV3 {
        schema_version: SCHEMA_VERSION,
        revision: copy.revision,
        launch_at_login: copy.launch_at_login,
        active_profile: copy.active_profile,
        profiles: copy.profiles,
        unbound_standalone: copy.unbound_standalone,
    };
    let bytes = serde_json::to_vec_pretty(&stored)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("桌面配置超过 64 KiB 上限，未保存");
    }
    Ok(bytes)
}
fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "desktop config exceeds 64 KiB",
        ));
    }
    Ok(bytes)
}
pub(crate) fn load() -> Result<Config> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    let path = config_path();
    let bytes = match read_bounded(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = Config::default();
            save_locked(&config)?;
            return Ok(config);
        }
        Err(error) => return Err(error).context("读取桌面配置失败（文件未改动）"),
    };
    let (config, migrated) = parse_config(&bytes).context("坏配置原样保留，未覆盖")?;
    if migrated {
        save_locked(&config).context("保存 schema v3 迁移失败（原文件未改动）")?;
    }
    Ok(config)
}
pub(crate) fn save(config: &Config) -> Result<()> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    save_locked(config)
}
/// The host's serialized commit boundary. Disk succeeds before revision/domain swap.
pub(crate) fn commit(current: &mut Config, next: Config) -> Result<()> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    commit_at(current, next, &base_dir())
}
fn commit_at(current: &mut Config, mut next: Config, directory: &Path) -> Result<()> {
    next.revision = next_revision(current.revision)?;
    next.store_active()?;
    save_at(&next, directory)?;
    if next.active_profile.is_none() {
        next.unbound_baseline = Some(StandalonePreferences {
            lyrics: next.lyrics.clone(),
            wallpaper: next.wallpaper.clone(),
        });
    }
    *current = next;
    Ok(())
}
fn save_locked(config: &Config) -> Result<()> {
    save_at(config, &base_dir())
}
fn save_at(config: &Config, dir: &Path) -> Result<()> {
    let bytes = encode_config(config)?;
    std::fs::create_dir_all(dir).context("创建桌面配置目录")?;
    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).context("创建配置临时文件")?;
        file.write_all(&bytes).context("写入桌面配置")?;
        file.sync_all().context("刷新桌面配置")?;
        drop(file);
        crate::native::replace_file(&tmp, &path).context("原子替换桌面配置")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 首次启动自动选一个 profile：只读两个规范数据目录，不扫描端口。
pub(crate) fn detect_profile() -> Option<Profile> {
    let mut candidates = Vec::new();
    for profile in detect_profiles() {
        let discovery = Path::new(profile.data_dir()).join("vmusicd.json");
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
        data_dir.is_dir().then(|| standalone(data_dir, edition))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_lyrics_config_keeps_style_and_gets_appearance_defaults() {
        let mut value = serde_json::to_value(LyricsConfig::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in [
            "theme",
            "surface",
            "align",
            "bilingual",
            "karaoke",
            "readabilityBoost",
        ] {
            object.remove(key);
        }
        value["layout"] = "double".into();
        value["fontSize"] = 44.0.into();
        value["sungColor"] = "#8fe3ff".into();
        let lyrics: LyricsConfig = serde_json::from_value(value).unwrap();
        assert_eq!(lyrics.layout, Layout::Double);
        assert_eq!(lyrics.font_size, 44.0);
        assert_eq!(lyrics.sung_color, "#8fe3ff");
        assert_eq!(lyrics.theme, LyricTheme::Auto);
        assert_eq!(lyrics.surface, LyricSurface::Bare);
        assert!(!lyrics.bilingual && lyrics.karaoke);
    }

    #[test]
    fn appearance_round_trips_in_its_profile_domain() {
        let mut config = Config::default();
        config.activate_profile(profile("a")).unwrap();
        config.lyrics.layout = Layout::Triple;
        config.lyrics.theme = LyricTheme::Light;
        config.lyrics.surface = LyricSurface::Glass;
        config.lyrics.align = LyricAlign::Right;
        config.lyrics.bilingual = true;
        config.lyrics.karaoke = false;
        config.lyrics.readability_boost = true;
        let (loaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert_eq!(loaded.lyrics.layout, Layout::Triple);
        assert_eq!(loaded.lyrics.theme, LyricTheme::Light);
        assert_eq!(loaded.lyrics.surface, LyricSurface::Glass);
        assert_eq!(loaded.lyrics.align, LyricAlign::Right);
        assert!(loaded.lyrics.bilingual && !loaded.lyrics.karaoke);
        assert!(loaded.lyrics.readability_boost);
    }

    fn profile(name: &str) -> Profile {
        standalone(PathBuf::from(format!(r"C:\profiles\{name}")), "full")
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
        assert_eq!(config.profiles[0].profile.data_dir(), r"C:\profiles\a");
        assert_eq!(config.profiles[0].lyrics.font_size, 44.0);
        assert_eq!(config.lyrics.font_size, 44.0);
        let encoded = encode_config(&config).unwrap();
        let encoded: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(encoded["schemaVersion"], 3);
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
        assert_eq!(
            config.unbound_standalone.as_ref().unwrap().lyrics.font_size,
            44.0
        );
        assert!(!config.lyrics.enabled);
        config.activate_profile(profile("a")).unwrap();
        let encoded = encode_config(&config).unwrap();
        let (loaded, migrated_again) = parse_config(&encoded).unwrap();
        assert!(!migrated_again);
        assert_eq!(loaded.lyrics.font_size, 44.0);
        assert_eq!(loaded.wallpaper.fps, 60);
        assert_eq!(loaded.profiles.len(), 1);
    }

    #[test]
    fn unbound_edits_survive_save_reload_and_first_binding() {
        let lyrics = LyricsConfig {
            font_size: 44.0,
            locked: true,
            ..Default::default()
        };
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"revision":5,"launchAtLogin":false,"activeProfile":null,
            "lyrics":lyrics,"wallpaper":WallpaperConfig::default()
        }))
        .unwrap();
        let (mut config, _) = parse_config(&bytes).unwrap();
        config.lyrics.font_size = 52.0;
        config.wallpaper.fps = 60;
        let (mut reloaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        reloaded.activate_profile(profile("first-binding")).unwrap();
        assert_eq!(reloaded.lyrics.font_size, 52.0);
        assert_eq!(reloaded.wallpaper.fps, 60);
        assert!(reloaded.lyrics.enabled && reloaded.lyrics.locked);
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
        assert_eq!(config.lyrics.font_size, LyricsConfig::default().font_size);
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
            loaded.active_profile.as_ref().unwrap().data_dir(),
            r"C:\profiles\a"
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
        let left = standalone(PathBuf::from(r"C:\Users\Miracle\hertz-studio"), "FULL");
        let right = standalone(PathBuf::from("c:/users/miracle/hertz-studio/"), "full");
        assert!(same_profile(&left, &right));
    }

    #[test]
    fn offline_profiles_collapse_dot_segments_before_duplicate_validation() {
        let left = standalone(PathBuf::from(r"C:\hertz-nonexistent\a\..\b\."), "full");
        let right = standalone(PathBuf::from(r"c:\hertz-nonexistent\b"), "full");
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
    fn dbx(name: &str) -> Profile {
        Profile::Dbx {
            data_dir: format!(r"C:\profiles\{name}"),
            edition: "standard".into(),
            plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
        }
    }
    #[test]
    fn unbound_legacy_preferences_survive_dbx_then_bind_to_standalone() {
        let lyrics = LyricsConfig {
            font_size: 48.0,
            locked: true,
            ..Default::default()
        };
        let wallpaper = WallpaperConfig {
            enabled: true,
            fps: 60,
            ..Default::default()
        };
        let bytes = serde_json::to_vec(
            &serde_json::json!({"schemaVersion":1,"revision":9,"launchAtLogin":true,
            "activeProfile":null,"lyrics":lyrics,"wallpaper":wallpaper}),
        )
        .unwrap();
        let (mut config, migrated) = parse_config(&bytes).unwrap();
        assert!(migrated);
        assert_eq!(config.revision, 10);
        assert!(!config.lyrics.enabled);
        let (restored, again) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!again);
        assert_eq!(restored.revision, 10);
        assert!(restored.unbound_standalone.is_some());
        config.activate_profile(dbx("dbx")).unwrap();
        assert!(!config.lyrics.enabled && !config.wallpaper.enabled);
        assert_eq!(config.lyrics.font_size, 30.0);
        assert!(config.unbound_standalone.is_some());
        let (mut config, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        config.activate_profile(profile("standalone")).unwrap();
        assert!(config.lyrics.enabled && config.lyrics.locked && config.wallpaper.enabled);
        assert_eq!(config.lyrics.font_size, 48.0);
        assert_eq!(config.wallpaper.fps, 60);
        assert!(config.unbound_standalone.is_none());
        assert!(config.launch_at_login);
    }
    #[test]
    fn schema2_custom_migrates_once_and_schema3_rejects_untagged_identity() {
        let domain = serde_json::json!({"profile":{"dataDir":r"C:\offline\custom","edition":"custom"},"lyrics":LyricsConfig::default(),"wallpaper":WallpaperConfig::default()});
        let value = serde_json::json!({"schemaVersion":2,"revision":17,"launchAtLogin":true,"activeProfile":domain["profile"],"profiles":[domain]});
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated);
        assert_eq!(config.revision, 18);
        assert!(
            matches!(config.active_profile,Some(Profile::Standalone{ref edition,..}) if edition=="custom")
        );
        let (config, again) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!again);
        assert_eq!(config.revision, 18);
        let mut invalid = value;
        invalid["schemaVersion"] = 3.into();
        assert!(parse_config(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    #[test]
    fn rejects_duplicate_identity_active_ninth_overflow_and_oversize() {
        let mut config = Config::default();
        for index in 0..8 {
            config
                .activate_profile(profile(&index.to_string()))
                .unwrap();
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&encode_config(&config).unwrap()).unwrap();
        value["activeProfile"] = serde_json::to_value(profile("ninth")).unwrap();
        assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        value["activeProfile"] = serde_json::Value::Null;
        value["profiles"][1] = value["profiles"][0].clone();
        assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
        let legacy = serde_json::json!({"schemaVersion":1,"revision":u64::MAX,"launchAtLogin":false,"activeProfile":null,"lyrics":LyricsConfig::default()});
        assert!(parse_config(&serde_json::to_vec(&legacy).unwrap()).is_err());
        assert!(next_revision(u64::MAX).is_err());
        assert!(parse_config(&vec![b' '; MAX_CONFIG_BYTES + 1]).is_err());
    }
    #[test]
    fn kind_plugin_and_windows_aliases_participate_in_identity() {
        let a = dbx("a");
        let standalone = standalone(PathBuf::from(a.data_dir()), a.edition());
        assert!(!same_profile(&a, &standalone));
        let mut wrong = a.clone();
        if let Profile::Dbx { plugin_id, .. } = &mut wrong {
            plugin_id.push_str(".wrong");
        }
        assert!(!same_profile(&a, &wrong));
        assert!(wrong.validate().is_err());
        let prefixed = Profile::Dbx {
            data_dir: r"\\?\c:\PROFILES\a\".into(),
            edition: "standard".into(),
            plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
        };
        assert!(same_profile(&a, &prefixed));
    }
    #[test]
    fn bounded_reader_rejects_a_large_file_before_parsing() {
        let path = std::env::temp_dir().join(format!(
            "hertz-dbx-config-bound-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, vec![b' '; MAX_CONFIG_BYTES + 1]).unwrap();
        assert!(read_bounded(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn atomic_writer_keeps_original_when_temp_write_or_encode_fails() {
        let dir =
            std::env::temp_dir().join(format!("hertz-dbx-config-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut original = Config::default();
        original.activate_profile(profile("a")).unwrap();
        save_at(&original, &dir).unwrap();
        let old = std::fs::read(dir.join("config.json")).unwrap();
        std::fs::create_dir(dir.join("config.json.tmp")).unwrap();
        let mut next = original.clone();
        next.revision = 2;
        next.lyrics.font_size = 50.0;
        assert!(commit_at(&mut original, next.clone(), &dir).is_err());
        assert_eq!(original.revision, 1);
        assert_eq!(original.lyrics.font_size, 30.0);
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), old);
        std::fs::remove_dir(dir.join("config.json.tmp")).unwrap();
        next.lyrics.font_family = "x".repeat(MAX_CONFIG_BYTES);
        assert!(save_at(&next, &dir).is_err());
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), old);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shared_windows_normalization_resolves_junctions() {
        let directory =
            std::env::temp_dir().join(format!("hertz-dbx-junction-{}", std::process::id()));
        let real = directory.join("real");
        let link = directory.join("alias");
        std::fs::create_dir_all(&real).unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let left = standalone(real, "standard");
        let right = standalone(link.clone(), "standard");
        assert!(same_profile(&left, &right));
        assert_eq!(
            normalize_profile(left).unwrap(),
            normalize_profile(right).unwrap()
        );
        std::fs::remove_dir(link).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn missing_dbx_active_domain_starts_disabled_and_preserves_unbound_preferences() {
        let old_lyrics = LyricsConfig {
            font_size: 44.0,
            ..Default::default()
        };
        let old_wallpaper = WallpaperConfig {
            enabled: true,
            ..Default::default()
        };
        let value = serde_json::json!({ "schemaVersion":3,"revision":7,"launchAtLogin":true,
            "activeProfile":dbx("missing-domain"),"profiles":[],
            "unboundStandalone":{"lyrics":old_lyrics,"wallpaper":old_wallpaper} });
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!migrated);
        assert_eq!(config.revision, 7);
        assert_eq!(config.profiles.len(), 1);
        assert!(!config.lyrics.enabled && !config.wallpaper.enabled);
        assert!(!config.profiles[0].lyrics.enabled && !config.profiles[0].wallpaper.enabled);
        let (mut restored, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        restored.activate_profile(profile("independent")).unwrap();
        assert!(restored.lyrics.enabled && restored.wallpaper.enabled);
        assert_eq!(restored.lyrics.font_size, 44.0);
        assert!(restored.launch_at_login);
        assert!(restored.unbound_standalone.is_none());
    }
}
