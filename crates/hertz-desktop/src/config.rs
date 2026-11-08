// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 唯一的桌面配置。持久配置表达用户意图；窗口/来源运行事实另行查询。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u32 = 5;
static COMMIT_LOCK: Mutex<()> = Mutex::new(());
pub(crate) use crate::wallpaper::config::WallpaperConfig;
pub(crate) use hertz_desktop_ipc::Profile;
pub(crate) const MAX_PROFILES: usize = 8;
pub(crate) const MAX_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) revision: u64,
    pub(crate) launch_at_login: bool,
    /// 全局“解锁并定位歌词”组合键；唯一宿主持有一份，不随来源切换（设计 §5.1）。
    pub(crate) recovery_hotkey: Option<crate::hotkey::Shortcut>,
    pub(crate) active_profile: Option<Profile>,
    pub(crate) profiles: Vec<ProfileDomain>,
    pub(crate) unbound_domain: Option<StandalonePreferences>,
    // Runtime view shown before binding; only edits to this view update legacy preferences.
    unbound_baseline: Option<StandalonePreferences>,
    pub(crate) lyrics: LyricsConfig,
    pub(crate) wallpaper: WallpaperConfig,
    pub(crate) mini: MiniConfig,
    /// 最后一次配置提交身份，由同一串行提交日志写入（设计 §14.1）。
    pub(crate) last_commit: Option<CommitRef>,
}

/// 与磁盘提交日志共同确认配置替换是否已经发生。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommitRef {
    pub(crate) request_id: String,
    pub(crate) payload_digest: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileDomain {
    pub(crate) profile: Profile,
    pub(crate) lyrics: LyricsConfig,
    pub(crate) wallpaper: WallpaperConfig,
    #[serde(default)]
    pub(crate) mini: MiniConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StandalonePreferences {
    lyrics: LyricsConfig,
    wallpaper: WallpaperConfig,
    #[serde(default)]
    mini: MiniConfig,
}

impl Config {
    pub(crate) fn wallpaper_references(
        &self,
        work_key: Option<&str>,
        package_hash: Option<&str>,
    ) -> crate::wallpaper::references::Report {
        let mut report = crate::wallpaper::references::Report::default();
        let mut collect = |wallpaper: &WallpaperConfig, id: &str, label: &str| {
            for group in &wallpaper.groups {
                let mut projected = wallpaper.clone();
                projected.groups = vec![group.clone()];
                if projected.references_package(work_key, package_hash) {
                    report.push(
                        "savedConfiguration",
                        &format!("{id}:{}", group.id),
                        label,
                        &format!(
                            "显示组 {} · {}。切换此组的作品并应用设置后解除引用。",
                            group.id,
                            if wallpaper.enabled {
                                "已启用"
                            } else {
                                "已停用，选择仍被保存"
                            }
                        ),
                    );
                }
            }
        };
        collect(&self.wallpaper, "current", "当前来源的壁纸选择");
        for (index, domain) in self.profiles.iter().enumerate() {
            collect(
                &domain.wallpaper,
                &format!("profile-{index}"),
                &format!(
                    "{} · {}",
                    domain.profile.edition(),
                    domain.profile.data_dir()
                ),
            );
        }
        if let Some(domain) = &self.unbound_domain {
            collect(&domain.wallpaper, "unbound", "未绑定来源的壁纸设置");
        }
        report
    }

    pub(crate) fn playlist_property_overrides(
        &self,
        playlist_id: &str,
    ) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let mut values = Vec::new();
        for wallpaper in std::iter::once(&self.wallpaper)
            .chain(self.profiles.iter().map(|profile| &profile.wallpaper))
            .chain(self.unbound_domain.iter().map(|domain| &domain.wallpaper))
        {
            for group in &wallpaper.groups {
                if !group.properties.is_empty()
                    && matches!(&group.selection, crate::wallpaper::config::Selection::Playlist { playlist_id: selected } if selected == playlist_id)
                    && !values.contains(&group.properties)
                {
                    values.push(group.properties.clone());
                }
            }
        }
        values
    }
}

/// 小窗播放（桌面宠物）的持久化域。全部字段带 default：旧 v4 文件没有
/// `mini` 键也照常解析，不需要 schema 迁移（设计文档 §7.6 的推荐做法）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MiniConfig {
    /// 上次退出时小窗还开着：这次启动自动恢复（EnterReason::Restored）。
    #[serde(default)]
    pub(crate) reopen: bool,
    /// 桌面宠物态：透明区域不吃鼠标（区域级穿透）。
    #[serde(default = "default_true")]
    pub(crate) pet: bool,
    /// 整体鼠标穿透（锁定）。
    #[serde(default)]
    pub(crate) locked: bool,
    #[serde(default = "default_true")]
    pub(crate) always_on_top: bool,
    /// 贴边自动隐藏。
    #[serde(default)]
    pub(crate) edge_hide: bool,
    /// 主窗口隐藏后自动接管。默认关：宁可不自动弹，也别在切标签页时冒出一扇窗。
    #[serde(default)]
    pub(crate) auto_on_main_hidden: bool,
    /// 尺寸档位（CSS --scale 同源）：0.85 / 1 / 1.2。
    #[serde(default)]
    pub(crate) scale: f64,
    #[serde(default = "default_mini_opacity")]
    pub(crate) opacity: f64,
    #[serde(default)]
    pub(crate) geometry: crate::mini::MiniGeometry,
}

fn default_mini_opacity() -> f64 {
    1.0
}

impl Default for MiniConfig {
    fn default() -> Self {
        Self {
            reopen: false,
            pet: true,
            locked: false,
            always_on_top: true,
            edge_hide: false,
            auto_on_main_hidden: false,
            scale: 1.0,
            opacity: 1.0,
            geometry: crate::mini::MiniGeometry::default(),
        }
    }
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

/// v4：新增 unboundDomain（自 v3 的 unboundStandalone 改名）、lastCommit，
/// 以及壁纸域的 brightness/motion/batteryPolicy/quality/displayId（见 WallpaperConfig 默认值）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfigV4 {
    schema_version: u32,
    revision: u64,
    launch_at_login: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_hotkey: Option<crate::hotkey::Shortcut>,
    active_profile: Option<Profile>,
    #[serde(default)]
    profiles: Vec<ProfileDomain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unbound_domain: Option<StandalonePreferences>,
    #[serde(default)]
    last_commit: Option<CommitRef>,
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

/// 壁纸电池策略。设计 §13.2：默认 pause；runLow 属 P1 的用户显式选项，v4 暂不开放。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BatteryPolicy {
    #[default]
    Pause,
}

/// 壁纸画质档位，映射到共享 stage 质量表（tools/space-stage/src/quality.js）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WallpaperQuality {
    #[default]
    Low,
    Medium,
    High,
}

impl WallpaperQuality {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            WallpaperQuality::Low => "low",
            WallpaperQuality::Medium => "medium",
            WallpaperQuality::High => "high",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyWallpaperConfig {
    pub(crate) enabled: bool,
    pub(crate) fps: u8,
    pub(crate) music_response: bool,
    pub(crate) monitor: Option<String>,
    /// 稳定显示器身份（DisplayConfig monitorDevicePath + EDID 摘要，设计 §2.2-9/§4.1）。
    /// 旧 `monitor` GDI 名仅作当前枚举映射；身份匹配成功后由宿主回填本字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) display_id: Option<String>,
    pub(crate) source: String,
    pub(crate) scene: String,
    /// 亮度 0.25–1，默认 1（设计 §4.3 v4 补齐）。
    #[serde(default = "default_wallpaper_brightness")]
    pub(crate) brightness: f64,
    /// 运动强度 0–1，默认 1；0 表示冻结环境运动（真实媒体时钟不变）。
    #[serde(default = "default_wallpaper_motion")]
    pub(crate) motion: f64,
    #[serde(default)]
    pub(crate) battery_policy: BatteryPolicy,
    #[serde(default)]
    pub(crate) quality: WallpaperQuality,
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

pub(crate) fn default_wallpaper_brightness() -> f64 {
    1.0
}

pub(crate) fn default_wallpaper_motion() -> f64 {
    1.0
}

/// 帧率只接受 15/30/60 三档（设计 §4.3）。迁移与 sanitize 统一取「不大于原值」的档；
/// 低于 15 时没有更小的档，回落 15。
pub(crate) fn fps_tier(value: u8) -> u8 {
    if value >= 60 {
        60
    } else if value >= 30 {
        30
    } else {
        15
    }
}

pub(crate) fn wallpaper_scene_allowed(scene: &str) -> bool {
    WALLPAPER_SCENES.iter().any(|(id, _)| *id == scene)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    pub(crate) show_vocals: bool,
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
            recovery_hotkey: None,
            active_profile: None,
            profiles: Vec::new(),
            unbound_domain: None,
            unbound_baseline: None,
            lyrics: LyricsConfig {
                enabled: false,
                ..Default::default()
            },
            wallpaper: WallpaperConfig::default(),
            mini: MiniConfig::default(),
            last_commit: None,
        }
    }
}

impl Default for LegacyWallpaperConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            fps: 30,
            music_response: true,
            monitor: None,
            display_id: None,
            source: default_wallpaper_source(),
            scene: default_wallpaper_scene(),
            brightness: default_wallpaper_brightness(),
            motion: default_wallpaper_motion(),
            battery_policy: BatteryPolicy::Pause,
            quality: WallpaperQuality::Low,
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
            show_vocals: true,
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
    /// Inactive profiles and the saved unbound domain still need their immutable packages.
    #[cfg(test)]
    pub(crate) fn references_wallpaper_package(
        &self,
        work_key: Option<&str>,
        package_hash: Option<&str>,
    ) -> bool {
        self.wallpaper.references_package(work_key, package_hash)
            || self
                .profiles
                .iter()
                .any(|domain| domain.wallpaper.references_package(work_key, package_hash))
            || self
                .unbound_domain
                .as_ref()
                .is_some_and(|domain| domain.wallpaper.references_package(work_key, package_hash))
    }

    pub(crate) fn sanitize(&mut self) {
        sanitize_lyrics(&mut self.lyrics);
        sanitize_mini(&mut self.mini);
        if let Some(unbound) = self.unbound_domain.as_mut() {
            sanitize_lyrics(&mut unbound.lyrics);
            sanitize_mini(&mut unbound.mini);
        }
        for domain in &mut self.profiles {
            sanitize_lyrics(&mut domain.lyrics);
            sanitize_mini(&mut domain.mini);
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
                mini: self.mini.clone(),
            };
            self.unbound_domain = Some(match (&self.unbound_domain, &self.unbound_baseline) {
                (Some(saved), Some(baseline)) => {
                    let mut saved = serde_json::to_value(saved)?;
                    let baseline = serde_json::to_value(baseline)?;
                    let current = serde_json::to_value(&current)?;
                    for domain in ["lyrics", "wallpaper", "mini"] {
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
            self.profiles[index].mini = self.mini.clone();
            return Ok(());
        }
        if self.profiles.len() >= MAX_PROFILES {
            bail!("桌面配置最多保存 {MAX_PROFILES} 个来源，请先整理 config.json");
        }
        self.profiles.push(ProfileDomain {
            profile,
            lyrics: self.lyrics.clone(),
            wallpaper: self.wallpaper.clone(),
            mini: self.mini.clone(),
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
            self.mini = self.profiles[index].mini.clone();
        } else {
            self.lyrics = LyricsConfig::default();
            self.lyrics.enabled = false;
            self.wallpaper = WallpaperConfig::default();
            self.mini = MiniConfig::default();
            self.profiles.push(ProfileDomain {
                profile: profile.clone(),
                lyrics: self.lyrics.clone(),
                wallpaper: self.wallpaper.clone(),
                mini: self.mini.clone(),
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

/// 小窗域的数值护栏：scale/opacity 夹进档位范围，几何里 NaN 回默认、
/// 沿边比例夹回 0..1。布尔字段天然安全，不用管。
fn sanitize_mini(mini: &mut MiniConfig) {
    if !mini.scale.is_finite() {
        mini.scale = 1.0;
    }
    mini.scale = mini.scale.clamp(0.85, 1.2);
    if !mini.opacity.is_finite() {
        mini.opacity = default_mini_opacity();
    }
    mini.opacity = mini.opacity.clamp(0.3, 1.0);
    if !mini.geometry.width.is_finite() {
        mini.geometry.width = crate::mini::MiniGeometry::default().width;
    }
    mini.geometry.width = mini.geometry.width.clamp(200.0, 480.0);
    if !mini.geometry.height.is_finite() {
        mini.geometry.height = crate::mini::MiniGeometry::default().height;
    }
    mini.geometry.height = mini.geometry.height.clamp(40.0, 120.0);
    if !mini.geometry.along.is_finite() {
        mini.geometry.along = 0.5;
    }
    mini.geometry.along = mini.geometry.along.clamp(0.0, 1.0);
}

pub(crate) fn validate_settings_lyrics(lyrics: &LyricsConfig) -> Result<()> {
    if ![
        lyrics.font_size,
        lyrics.outline_width,
        lyrics.opacity,
        lyrics.width,
        lyrics.anchor_x,
        lyrics.anchor_y,
    ]
    .iter()
    .all(|value| value.is_finite())
        || lyrics.font_family.len() > 256
        || lyrics
            .monitor
            .as_ref()
            .is_some_and(|value| value.len() > 256)
    {
        bail!("歌词样式数值或文本超过限制");
    }
    let mut normalized = lyrics.clone();
    sanitize_lyrics(&mut normalized);
    if &normalized != lyrics {
        bail!("歌词样式不符合当前参数范围");
    }
    Ok(())
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

fn sanitize_legacy_wallpaper(wallpaper: &mut LegacyWallpaperConfig) {
    // v4 起帧率只保留 15/30/60 三档，不再 sanitize 任意整数（设计 §4.3）。
    wallpaper.fps = fps_tier(wallpaper.fps);
    wallpaper.monitor = wallpaper
        .monitor
        .take()
        .map(|monitor| monitor.trim().to_string())
        .filter(|monitor| !monitor.is_empty());
    wallpaper.display_id = wallpaper
        .display_id
        .take()
        .map(|display_id| display_id.trim().to_string())
        .filter(|display_id| !display_id.is_empty() && display_id.len() <= 256);
    if wallpaper.brightness.is_nan() {
        wallpaper.brightness = default_wallpaper_brightness();
    }
    wallpaper.brightness = wallpaper.brightness.clamp(0.25, 1.0);
    if wallpaper.motion.is_nan() {
        wallpaper.motion = default_wallpaper_motion();
    }
    wallpaper.motion = wallpaper.motion.clamp(0.0, 1.0);
    if !matches!(wallpaper.source.as_str(), "follow" | "fixed") {
        wallpaper.source = default_wallpaper_source();
    }
    if !wallpaper_scene_allowed(&wallpaper.scene) {
        wallpaper.scene = default_wallpaper_scene();
    }
}

impl LegacyWallpaperConfig {
    pub(crate) fn migrate(
        mut self,
        monitors: &[crate::native::WallpaperMonitor],
        normalize_legacy: bool,
    ) -> Result<WallpaperConfig> {
        use crate::wallpaper::config::{AudioInput, BuiltinState, DisplaySelection, Selection};
        if normalize_legacy {
            sanitize_legacy_wallpaper(&mut self);
        }
        let mut next = WallpaperConfig {
            enabled: self.enabled,
            battery_policy: self.battery_policy,
            ..Default::default()
        };
        if !self.music_response {
            next.audio_input = AudioInput::None;
        }
        let group = next.main_mut();
        group.presentation.fps = self.fps;
        group.presentation.quality = self.quality;
        group.presentation.brightness = self.brightness;
        group.presentation.motion = self.motion;
        group.displays = vec![if let Some(display_id) = self.display_id {
            DisplaySelection::Fixed { display_id }
        } else if let Some(name) = self.monitor {
            match monitors.iter().find(|monitor| monitor.name == name) {
                Some(monitor) => DisplaySelection::Fixed {
                    display_id: monitor.display_id(),
                },
                None => DisplaySelection::Unresolved { legacy_name: name },
            }
        } else {
            DisplaySelection::Primary
        }];
        group.selection = match self.source.as_str() {
            "fixed" => Selection::Builtin {
                scene_id: self.scene,
                state_version: 1,
                params: serde_json::Map::new(),
            },
            "follow" => Selection::FollowHertz {
                idle_builtin: BuiltinState {
                    scene_id: self.scene,
                    state_version: 1,
                    params: serde_json::Map::new(),
                },
            },
            _ => bail!("不支持的壁纸来源"),
        };
        next.normalize()?;
        Ok(next)
    }
}
fn migrate_wallpaper_domains(value: &mut serde_json::Value, schema: u64) -> Result<()> {
    let monitors = crate::native::wallpaper_monitors();
    fn migrate(
        value: &mut serde_json::Value,
        monitors: &[crate::native::WallpaperMonitor],
        schema: u64,
    ) -> Result<()> {
        if let Some(wallpaper) = value.get_mut("wallpaper") {
            let legacy: LegacyWallpaperConfig = serde_json::from_value(wallpaper.clone())?;
            *wallpaper = serde_json::to_value(legacy.migrate(monitors, schema < 4)?)?;
        }
        Ok(())
    }
    migrate(value, &monitors, schema)?;
    for key in ["unboundStandalone", "unboundDomain"] {
        if let Some(domain) = value.get_mut(key) {
            migrate(domain, &monitors, schema)?;
        }
    }
    if let Some(domains) = value
        .get_mut("profiles")
        .and_then(serde_json::Value::as_array_mut)
    {
        for domain in domains {
            migrate(domain, &monitors, schema)?;
        }
    }
    Ok(())
}
fn normalize_wallpapers(config: &mut Config) -> Result<()> {
    config.wallpaper.normalize()?;
    if let Some(unbound) = config.unbound_domain.as_mut() {
        unbound.wallpaper.normalize()?;
    }
    for domain in &mut config.profiles {
        domain.wallpaper.normalize()?;
    }
    Ok(())
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
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    let schema = value.get("schemaVersion").and_then(|value| value.as_u64());
    if matches!(schema, Some(1..=4)) {
        migrate_wallpaper_domains(&mut value, schema.unwrap())?;
    }
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
                mini: MiniConfig::default(),
            });
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                recovery_hotkey: None,
                active_profile: active.clone(),
                profiles: active
                    .into_iter()
                    .map(|profile| ProfileDomain {
                        profile,
                        lyrics: stored.lyrics.clone(),
                        wallpaper: stored.wallpaper.clone(),
                        mini: MiniConfig::default(),
                    })
                    .collect(),
                unbound_domain: unbound,
                unbound_baseline: None,
                lyrics: stored.lyrics,
                wallpaper: stored.wallpaper,
                mini: MiniConfig::default(),
                last_commit: None,
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
                        mini: MiniConfig::default(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                recovery_hotkey: None,
                active_profile: stored
                    .active_profile
                    .map(LegacyProfile::migrate)
                    .transpose()?,
                profiles,
                unbound_domain: None,
                unbound_baseline: None,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
                mini: MiniConfig::default(),
                last_commit: None,
            }
        }
        Some(3) => {
            let stored: StoredConfigV3 = serde_json::from_value(value)?;
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                recovery_hotkey: None,
                active_profile: stored.active_profile,
                profiles: stored.profiles,
                unbound_domain: stored.unbound_standalone,
                unbound_baseline: None,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
                mini: MiniConfig::default(),
                last_commit: None,
            }
        }
        Some(4 | 5) => {
            let stored: StoredConfigV4 = serde_json::from_value(value)?;
            Config {
                revision: stored.revision,
                launch_at_login: stored.launch_at_login,
                recovery_hotkey: stored.recovery_hotkey,
                active_profile: stored.active_profile,
                profiles: stored.profiles,
                unbound_domain: stored.unbound_domain,
                unbound_baseline: None,
                lyrics: LyricsConfig::default(),
                wallpaper: WallpaperConfig::default(),
                mini: MiniConfig::default(),
                last_commit: stored.last_commit,
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
            config.mini = config.profiles[index].mini.clone();
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
                mini: config.mini.clone(),
            });
        }
    } else if let Some(unbound) = config.unbound_domain.as_ref() {
        config.lyrics = unbound.lyrics.clone();
        config.wallpaper = unbound.wallpaper.clone();
        config.mini = unbound.mini.clone();
    }
    validate_domains(&config)?;
    config.sanitize();
    normalize_wallpapers(&mut config)?;
    if config.active_profile.is_none() {
        config.unbound_baseline = Some(StandalonePreferences {
            lyrics: config.lyrics.clone(),
            wallpaper: config.wallpaper.clone(),
            mini: config.mini.clone(),
        });
    }
    let migrated = schema != Some(u64::from(SCHEMA_VERSION));
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
    normalize_wallpapers(&mut copy)?;
    copy.store_active()?;
    validate_domains(&copy)?;
    if let Some(active) = copy.active_profile.as_ref() {
        active.validate()?;
    }
    let stored = StoredConfigV4 {
        schema_version: SCHEMA_VERSION,
        revision: copy.revision,
        launch_at_login: copy.launch_at_login,
        recovery_hotkey: copy.recovery_hotkey.clone(),
        active_profile: copy.active_profile,
        profiles: copy.profiles,
        unbound_domain: copy.unbound_domain,
        last_commit: copy.last_commit,
    };
    let bytes = serde_json::to_vec_pretty(&stored)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("桌面配置超过 64 KiB 上限，未保存");
    }
    Ok(bytes)
}
pub(crate) fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
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
    load_with_notice().map(|(config, _)| config)
}

/// 迁移说明只在本次启动有效：v3→v4 归一帧率等一次性数据修正需要向用户交代一次。
pub(crate) fn load_with_notice() -> Result<(Config, Option<String>)> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    let directory = base_dir();
    let _root_owner = crate::wallpaper_upgrade::admit_config(&directory)?;
    let _file_lock = crate::config_journal::FileLock::acquire(&directory)?;
    let recovery_notice = match reconcile_journal_at(&directory) {
        Ok(false) => None,
        Ok(true) => {
            Some("配置与提交日志不符，已保留文件并暂停写入，请恢复配置后重试。".to_string())
        }
        Err(error) => Some(format!(
            "配置提交记录无法核对，已保留文件并暂停写入：{error:#}"
        )),
    };
    let path = config_path();
    let bytes = match read_bounded(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(notice) = recovery_notice {
                bail!("{notice}");
            }
            let config = Config::default();
            save_locked(&config)?;
            return Ok((config, None));
        }
        Err(error) => return Err(error).context("读取桌面配置失败（文件未改动）"),
    };
    let notice = recovery_notice.or_else(|| migration_notice(&bytes));
    let (config, migrated) = parse_config(&bytes).context("坏配置原样保留，未覆盖")?;
    if migrated {
        if reconcile_journal_at(&directory)? {
            bail!(crate::config_journal::JournalError::Conflict);
        }
        use std::io::Write;
        let old_schema = serde_json::from_slice::<serde_json::Value>(&bytes)?["schemaVersion"]
            .as_u64()
            .unwrap_or(0);
        let backup = path.with_file_name(format!(
            "config.v{old_schema}.{}.{}.bak",
            config.revision,
            crate::wallpaper::jobs::new_job_id()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(backup)
            .context("创建迁移备份失败，原配置未改动")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .context("保存迁移备份失败，原配置未改动")?;
        drop(file);
        save_locked(&config).context("保存配置格式迁移失败（原文件未改动）")?;
    }
    Ok((config, notice))
}

/// 迁移说明（一次性，内存态）：旧文件里出现非 15/30/60 档的帧率时提示已归一。
fn migration_notice(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let schema = value
        .get("schemaVersion")
        .and_then(|value| value.as_u64())?;
    if schema >= u64::from(SCHEMA_VERSION) {
        return None;
    }
    let mut domains = Vec::new();
    if let Some(wallpaper) = value.get("wallpaper") {
        domains.push(wallpaper);
    }
    if let Some(unbound) = value.get("unboundStandalone") {
        if let Some(wallpaper) = unbound.get("wallpaper") {
            domains.push(wallpaper);
        }
    }
    if let Some(profiles) = value.get("profiles").and_then(|value| value.as_array()) {
        for profile in profiles {
            if let Some(wallpaper) = profile.get("wallpaper") {
                domains.push(wallpaper);
            }
        }
    }
    let normalized = domains.iter().any(|wallpaper| {
        matches!(wallpaper.get("fps").and_then(|value| value.as_u64()), Some(fps) if !matches!(fps, 15 | 30 | 60))
    });
    Some(if normalized {
        "桌面设置已升级到新格式：帧率已归一到 15/30/60 档。".into()
    } else {
        "桌面设置已升级到新格式（schema v5）。".into()
    })
}
/// The host's serialized commit boundary. Disk succeeds before revision/domain swap.
pub(crate) fn commit(current: &mut Config, next: Config) -> Result<()> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    commit_at(current, next, &base_dir())
}
pub(crate) fn commit_request(
    current: &mut Config,
    next: Config,
    intent: &crate::config_journal::Intent,
) -> Result<crate::config_journal::Operation> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    commit_named_at(current, next, &base_dir(), intent)
}

pub(crate) fn replay_request(
    intent: &crate::config_journal::Intent,
) -> Result<Option<crate::config_journal::Operation>> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    let directory = base_dir();
    let _root_owner = crate::wallpaper_upgrade::admit_config(&directory)?;
    let _file_lock = crate::config_journal::FileLock::acquire(&directory)?;
    let mut journal = crate::config_journal::Store::open(&directory)?;
    journal.reconcile(&directory)?;
    journal.replay(intent)
}

fn commit_at(current: &mut Config, next: Config, directory: &Path) -> Result<()> {
    let intent = crate::config_journal::Intent::internal(&encode_config(&next)?)?;
    commit_named_at(current, next, directory, &intent)?;
    Ok(())
}

/// A replay returns its retained operation without reapplying an older candidate to memory.
fn commit_named_at(
    current: &mut Config,
    mut next: Config,
    directory: &Path,
    intent: &crate::config_journal::Intent,
) -> Result<crate::config_journal::Operation> {
    use crate::config_journal::{JournalError, Store};
    let _root_owner = crate::wallpaper_upgrade::admit_config(directory)?;
    let _file_lock = crate::config_journal::FileLock::acquire(directory)?;
    let mut journal = Store::open(directory)?;
    journal.reconcile(directory)?;
    if let Some(operation) = journal.replay(intent)? {
        return Ok(operation);
    }
    if journal.blocked() {
        bail!(JournalError::Conflict);
    }
    let base = read_bounded(&directory.join("config.json"))?;
    let (stored, migrated) = parse_config(&base)?;
    if migrated || stored.revision != current.revision || stored.last_commit != current.last_commit
    {
        bail!(JournalError::Conflict);
    }
    next.revision = next_revision(current.revision)?;
    next.last_commit = Some(CommitRef {
        request_id: intent.request_id.clone(),
        payload_digest: intent.payload_digest.clone(),
    });
    normalize_wallpapers(&mut next)?;
    next.store_active()?;
    let target = encode_config(&next)?;
    journal.prepare(intent, &base, &target)?;
    if let Err(error) = save_bytes_at(&target, directory) {
        // A failure to finalize leaves an intent that startup will classify against the original file.
        let _ = journal.finish(&intent.caller_sid, &intent.request_id, false);
        return Err(error);
    }
    if next.active_profile.is_none() {
        next.unbound_baseline = Some(StandalonePreferences {
            lyrics: next.lyrics.clone(),
            wallpaper: next.wallpaper.clone(),
            mini: next.mini.clone(),
        });
    }
    *current = next;
    match journal.finish(&intent.caller_sid, &intent.request_id, true) {
        Ok(operation) => Ok(operation),
        Err(error) => {
            // Disk is authoritative even if the final receipt failed. No subsequent write can pass
            // reconciliation until that receipt is flushed; never roll memory back to an older intent.
            crate::app::log(&format!(
                "config saved; journal finalization pending: {error:#}"
            ));
            journal
                .lookup(&intent.caller_sid, &intent.request_id)
                .context("提交记录缺失")
        }
    }
}

fn reconcile_journal_at(directory: &Path) -> Result<bool> {
    let mut journal = crate::config_journal::Store::open(directory)?;
    journal.reconcile(directory)?;
    Ok(journal.blocked())
}

pub(crate) fn operation_at(
    directory: &Path,
    request_id: &str,
) -> Result<Option<crate::config_journal::Operation>> {
    let _commit = COMMIT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("配置保存锁不可用"))?;
    if !directory.exists() {
        return Ok(None);
    }
    let _root_owner = crate::wallpaper_upgrade::admit_config(directory)?;
    let _file_lock = crate::config_journal::FileLock::acquire(directory)?;
    let mut journal = crate::config_journal::Store::open(directory)?;
    journal.reconcile(directory)?;
    Ok(journal.lookup(&crate::config_journal::caller_sid()?, request_id))
}
fn save_locked(config: &Config) -> Result<()> {
    save_at(config, &base_dir())
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use crate::wallpaper::library::{tempfileish, Library};

    #[tokio::test]
    async fn commits_and_journal_reads_refuse_maintenance_and_future_database_before_mutation() {
        let dir = tempfileish::temp_dir("config-root-admission");
        let mut config = Config::default();
        save_at(&config, dir.path()).unwrap();
        let before = std::fs::read(dir.path().join("config.json")).unwrap();
        let owner = crate::root_owner::RootOwner::exclusive(dir.path()).unwrap();
        let intent = crate::config_journal::Intent::internal(b"root-admission").unwrap();
        let next = config.clone();
        assert!(commit_named_at(&mut config, next, dir.path(), &intent).is_err());
        assert!(operation_at(dir.path(), "root-admission").is_err());
        assert_eq!(
            std::fs::read(dir.path().join("config.json")).unwrap(),
            before
        );
        assert!(!dir.path().join("operations").exists());
        drop(owner);
        let library = Library::open(dir.path()).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET version=99 WHERE version=6")
            .execute(library.pool())
            .await
            .unwrap();
        library.pool().close().await;
        drop(library);
        let next = config.clone();
        assert!(commit_named_at(&mut config, next, dir.path(), &intent).is_err());
        assert!(operation_at(dir.path(), "root-admission").is_err());
        assert_eq!(
            std::fs::read(dir.path().join("config.json")).unwrap(),
            before
        );
        assert!(!dir.path().join("operations").exists());
    }
}
fn save_at(config: &Config, dir: &Path) -> Result<()> {
    let bytes = encode_config(config)?;
    save_bytes_at(&bytes, dir)
}
fn save_bytes_at(bytes: &[u8], dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).context("创建桌面配置目录")?;
    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).context("创建配置临时文件")?;
        file.write_all(bytes).context("写入桌面配置")?;
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
    #[test]
    fn show_vocals_legacy_default_and_explicit_choices_preserve_other_preferences() {
        let mut value = serde_json::to_value(super::LyricsConfig::default()).unwrap();
        value["fontSize"] = serde_json::json!(46.0);
        value["layout"] = serde_json::json!("triple");
        value["bilingual"] = serde_json::json!(true);
        value.as_object_mut().unwrap().remove("showVocals");
        let legacy: super::LyricsConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(legacy.show_vocals);
        for enabled in [false, true] {
            value["showVocals"] = serde_json::json!(enabled);
            let saved: super::LyricsConfig = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(saved.show_vocals, enabled);
            assert_eq!(saved.font_size, 46.0);
            assert_eq!(saved.layout, super::Layout::Triple);
            assert!(saved.bilingual);
        }
    }
    use super::*;

    #[test]
    fn playlist_property_guards_include_inactive_profiles_and_unbound_intent() {
        let mut config = Config::default();
        config.wallpaper.main_mut().selection = crate::wallpaper::config::Selection::Playlist {
            playlist_id: "shared-list".into(),
        };
        config
            .wallpaper
            .main_mut()
            .properties
            .insert("brightness".into(), serde_json::json!(0.3));
        let mut inactive = config.wallpaper.clone();
        inactive.enabled = false;
        inactive
            .main_mut()
            .properties
            .insert("brightness".into(), serde_json::json!(0.4));
        config.profiles.push(ProfileDomain {
            profile: standalone(PathBuf::from("C:/public-properties-other"), "full"),
            lyrics: LyricsConfig::default(),
            wallpaper: inactive,
            mini: MiniConfig::default(),
        });
        let mut unbound = config.wallpaper.clone();
        unbound
            .main_mut()
            .properties
            .insert("brightness".into(), serde_json::json!(0.5));
        config.unbound_domain = Some(StandalonePreferences {
            lyrics: LyricsConfig::default(),
            wallpaper: unbound,
            mini: MiniConfig::default(),
        });
        let values = config.playlist_property_overrides("shared-list");
        assert_eq!(values.len(), 3);
        assert_eq!(
            values
                .iter()
                .map(|value| value["brightness"].as_f64().unwrap())
                .collect::<Vec<_>>(),
            vec![0.3, 0.4, 0.5]
        );
        assert!(config.playlist_property_overrides("other-list").is_empty());
    }

    #[test]
    fn old_lyrics_config_keeps_style_and_gets_appearance_defaults() {
        let mut value = serde_json::to_value(LyricsConfig::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in [
            "theme",
            "surface",
            "align",
            "bilingual",
            "showVocals",
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
        assert!(lyrics.show_vocals);
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
        config.lyrics.show_vocals = false;
        config.lyrics.karaoke = false;
        config.lyrics.readability_boost = true;
        let (loaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert_eq!(loaded.lyrics.layout, Layout::Triple);
        assert_eq!(loaded.lyrics.theme, LyricTheme::Light);
        assert_eq!(loaded.lyrics.surface, LyricSurface::Glass);
        assert_eq!(loaded.lyrics.align, LyricAlign::Right);
        assert!(loaded.lyrics.bilingual && !loaded.lyrics.karaoke);
        assert!(!loaded.lyrics.show_vocals);
        assert!(loaded.lyrics.readability_boost);
    }

    fn profile(name: &str) -> Profile {
        standalone(PathBuf::from(format!(r"C:\profiles\{name}")), "full")
    }

    #[test]
    fn deletion_protects_inactive_profiles_and_saved_unbound_wallpaper() {
        use crate::wallpaper::config::Selection;
        let mut config = Config::default();
        config.wallpaper.enabled = false;
        config.wallpaper.main_mut().selection = Selection::Package {
            work_key: "unbound-work".into(),
            package_hash: "a".repeat(64),
        };
        config.activate_profile(profile("a")).unwrap();
        config.wallpaper.main_mut().selection = Selection::Package {
            work_key: "profile-work".into(),
            package_hash: "b".repeat(64),
        };
        config.activate_profile(profile("b")).unwrap();
        let (mut loaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!loaded
            .wallpaper
            .references_package(Some("profile-work"), None));
        assert!(loaded.references_wallpaper_package(Some("profile-work"), None));
        assert!(loaded.references_wallpaper_package(None, Some(&"b".repeat(64))));
        assert!(loaded.references_wallpaper_package(Some("unbound-work"), None));
        assert!(loaded.references_wallpaper_package(None, Some(&"a".repeat(64))));
        let inactive =
            serde_json::to_value(loaded.wallpaper_references(Some("profile-work"), None)).unwrap();
        assert!(inactive["references"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["label"]
                .as_str()
                .unwrap()
                .contains(r"C:\profiles\a")));
        let unbound =
            serde_json::to_value(loaded.wallpaper_references(None, Some(&"a".repeat(64)))).unwrap();
        assert!(unbound["references"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["id"].as_str().unwrap().starts_with("unbound:")));
        assert!(loaded
            .wallpaper_references(Some("other-work"), Some(&"c".repeat(64)))
            .is_empty());
        assert!(!loaded.references_wallpaper_package(Some("other-work"), Some(&"c".repeat(64))));
        loaded.activate_profile(profile("a")).unwrap();
        loaded.wallpaper = WallpaperConfig::default();
        loaded.store_active().unwrap();
        assert!(!loaded.references_wallpaper_package(Some("profile-work"), None));
        assert!(loaded.references_wallpaper_package(Some("unbound-work"), None));
    }

    #[test]
    fn v1_config_moves_domain_under_active_profile() {
        let lyrics = serde_json::to_value(LyricsConfig::default()).unwrap();
        let wallpaper = serde_json::to_value(LegacyWallpaperConfig::default()).unwrap();
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
        assert_eq!(encoded["schemaVersion"], 5);
        assert!(encoded.get("lyrics").is_none());
        assert_eq!(encoded["profiles"][0]["lyrics"]["fontSize"], 44.0);
    }

    #[test]
    fn v1_without_active_profile_keeps_domain_until_binding() {
        let lyrics = serde_json::to_value(LyricsConfig::default()).unwrap();
        let wallpaper = serde_json::to_value(LegacyWallpaperConfig::default()).unwrap();
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
            config.unbound_domain.as_ref().unwrap().lyrics.font_size,
            44.0
        );
        assert!(config.lyrics.enabled);
        config.activate_profile(profile("a")).unwrap();
        let encoded = encode_config(&config).unwrap();
        let (loaded, migrated_again) = parse_config(&encoded).unwrap();
        assert!(!migrated_again);
        assert!(!loaded.lyrics.enabled);
        assert_eq!(
            loaded.unbound_domain.as_ref().unwrap().lyrics.font_size,
            44.0
        );
        assert_eq!(
            loaded
                .unbound_domain
                .as_ref()
                .unwrap()
                .wallpaper
                .presentation()
                .fps,
            60
        );
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
            "lyrics":lyrics,"wallpaper":LegacyWallpaperConfig::default()
        }))
        .unwrap();
        let (mut config, _) = parse_config(&bytes).unwrap();
        config.lyrics.font_size = 52.0;
        config.wallpaper.main_mut().presentation.fps = 60;
        let (mut reloaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert_eq!(reloaded.lyrics.font_size, 52.0);
        assert_eq!(reloaded.wallpaper.presentation().fps, 60);
        assert!(reloaded.lyrics.enabled && reloaded.lyrics.locked);
        reloaded.activate_profile(profile("first-binding")).unwrap();
        assert!(!reloaded.lyrics.enabled && !reloaded.wallpaper.enabled);
        assert_eq!(
            reloaded.unbound_domain.as_ref().unwrap().lyrics.font_size,
            52.0
        );
    }

    #[test]
    fn switching_profiles_keeps_independent_domains() {
        let a = profile("a");
        let b = profile("b");
        let mut config = Config::default();
        assert!(config.activate_profile(a.clone()).unwrap());
        config.lyrics.font_size = 44.0;
        config.wallpaper.main_mut().presentation.fps = 60;
        config.wallpaper.enabled = true;

        assert!(config.activate_profile(b.clone()).unwrap());
        assert_eq!(config.lyrics.font_size, LyricsConfig::default().font_size);
        assert!(!config.wallpaper.enabled);
        config.lyrics.font_size = 20.0;

        assert!(config.activate_profile(a.clone()).unwrap());
        assert_eq!(config.lyrics.font_size, 44.0);
        assert_eq!(config.wallpaper.presentation().fps, 60);
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
        let mut value = serde_json::to_value(LegacyWallpaperConfig::default()).unwrap();
        assert_eq!(value["source"], "follow");
        assert_eq!(value["scene"], "zodiac");
        value.as_object_mut().unwrap().remove("source");
        value.as_object_mut().unwrap().remove("scene");
        let defaults: LegacyWallpaperConfig = serde_json::from_value(value).unwrap();
        assert_eq!(defaults.source, "follow");
        assert_eq!(defaults.scene, "zodiac");

        let mut invalid: LegacyWallpaperConfig = serde_json::from_value(serde_json::json!({
            "enabled": false,
            "fps": 30,
            "musicResponse": true,
            "source": "something",
            "scene": "cover-sphere"
        }))
        .unwrap();
        sanitize_legacy_wallpaper(&mut invalid);
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
        let wallpaper = LegacyWallpaperConfig {
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
        assert!(config.lyrics.enabled && config.wallpaper.enabled);
        let (restored, again) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!again);
        assert_eq!(restored.revision, 10);
        assert!(restored.unbound_domain.is_some());
        config.activate_profile(dbx("dbx")).unwrap();
        assert!(!config.lyrics.enabled && !config.wallpaper.enabled);
        assert_eq!(config.lyrics.font_size, 30.0);
        assert!(config.unbound_domain.is_some());
        let (mut config, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        config.activate_profile(profile("standalone")).unwrap();
        assert!(!config.lyrics.enabled && !config.wallpaper.enabled);
        let unbound = config.unbound_domain.as_ref().unwrap();
        assert_eq!(unbound.lyrics.font_size, 48.0);
        assert_eq!(unbound.wallpaper.presentation().fps, 60);
        assert!(config.launch_at_login);
    }
    #[test]
    fn schema2_custom_migrates_once_and_schema3_rejects_untagged_identity() {
        let domain = serde_json::json!({"profile":{"dataDir":r"C:\offline\custom","edition":"custom"},"lyrics":LyricsConfig::default(),"wallpaper":LegacyWallpaperConfig::default()});
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
    fn recovery_hotkey_is_global_defaults_empty_and_survives_roundtrip() {
        // 旧配置没有该字段：默认空，revision 不因此变化。
        let legacy = serde_json::json!({"schemaVersion":5,"revision":4,"launchAtLogin":false,"activeProfile":null});
        let (config, migrated) = parse_config(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(!migrated);
        assert_eq!(config.recovery_hotkey, None);
        assert_eq!(config.revision, 4);
        // 组合键是宿主全局字段：跨来源切换保持不变，roundtrip 保留原文。
        let config = Config {
            recovery_hotkey: Some("Ctrl+Alt+L".parse().unwrap()),
            ..Config::default()
        };
        let encoded = encode_config(&config).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["recoveryHotkey"], "Ctrl+Alt+L");
        let (mut config, _) = parse_config(&encoded).unwrap();
        assert_eq!(
            config
                .recovery_hotkey
                .as_ref()
                .map(crate::hotkey::Shortcut::as_str),
            Some("Ctrl+Alt+L")
        );
        config.activate_profile(dbx("dbx")).unwrap();
        assert_eq!(
            config
                .recovery_hotkey
                .as_ref()
                .map(crate::hotkey::Shortcut::as_str),
            Some("Ctrl+Alt+L")
        );
        // 存量文件里的非法组合键按配置损坏处理，不静默丢弃。
        for stored in ["Ctrl+Alt+F12", "Ctrl+L", "Win+Ctrl+L", "不是快捷键"] {
            let invalid = serde_json::json!({"schemaVersion":5,"revision":4,"launchAtLogin":false,"activeProfile":null,"recoveryHotkey":stored});
            assert!(
                parse_config(&serde_json::to_vec(&invalid).unwrap()).is_err(),
                "unexpectedly accepted {stored}"
            );
        }
        // 未设置时编码不出现该字段，保持旧宿主可读。
        let value: serde_json::Value =
            serde_json::from_slice(&encode_config(&Config::default()).unwrap()).unwrap();
        assert!(value.get("recoveryHotkey").is_none());
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
        let old_wallpaper = LegacyWallpaperConfig {
            enabled: true,
            ..Default::default()
        };
        let value = serde_json::json!({ "schemaVersion":3,"revision":7,"launchAtLogin":true,
            "activeProfile":dbx("missing-domain"),"profiles":[],
            "unboundStandalone":{"lyrics":old_lyrics,"wallpaper":old_wallpaper} });
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        // v3→v4 迁移只发生一次：revision 递增，域语义保持不变。
        assert!(migrated);
        assert_eq!(config.revision, 8);
        assert_eq!(config.profiles.len(), 1);
        assert!(!config.lyrics.enabled && !config.wallpaper.enabled);
        assert!(!config.profiles[0].lyrics.enabled && !config.profiles[0].wallpaper.enabled);
        let (mut restored, again) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!again);
        assert_eq!(restored.revision, 8);
        restored.activate_profile(profile("independent")).unwrap();
        assert!(!restored.lyrics.enabled && !restored.wallpaper.enabled);
        assert_eq!(
            restored.unbound_domain.as_ref().unwrap().lyrics.font_size,
            44.0
        );
        assert!(restored.launch_at_login);
    }

    #[test]
    fn v4_migration_adds_runtime_defaults_once_and_normalizes_fps() {
        let lyrics = LyricsConfig::default();
        let wallpaper = LegacyWallpaperConfig {
            fps: 45,
            ..Default::default()
        };
        let value = serde_json::json!({"schemaVersion":3,"revision":7,"launchAtLogin":true,
            "activeProfile":null,
            "unboundStandalone":{"lyrics":lyrics,"wallpaper":wallpaper}});
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated);
        assert_eq!(config.revision, 8);
        assert_eq!(config.wallpaper.presentation().fps, 30);
        assert_eq!(config.wallpaper.presentation().brightness, 1.0);
        assert_eq!(config.wallpaper.presentation().motion, 1.0);
        assert_eq!(
            config.wallpaper.presentation().quality,
            WallpaperQuality::Low
        );
        assert_eq!(config.wallpaper.battery_policy, BatteryPolicy::Pause);
        assert_eq!(
            config
                .unbound_domain
                .as_ref()
                .unwrap()
                .wallpaper
                .presentation()
                .fps,
            30
        );
        let (reloaded, again_migrated) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!again_migrated);
        assert_eq!(reloaded.revision, 8);
        let encoded: serde_json::Value =
            serde_json::from_slice(&encode_config(&reloaded).unwrap()).unwrap();
        assert_eq!(encoded["schemaVersion"], 5);
        assert!(encoded.get("unboundStandalone").is_none());
        assert!(encoded["unboundDomain"].is_object());
        assert_eq!(encoded["lastCommit"], serde_json::Value::Null);
    }

    #[test]
    fn v5_round_trips_presentation_and_explicit_stable_display() {
        use crate::wallpaper::config::DisplaySelection;
        let mut config = Config::default();
        config.activate_profile(profile("a")).unwrap();
        config.wallpaper.main_mut().presentation.brightness = 0.5;
        config.wallpaper.main_mut().presentation.motion = 0.0;
        config.wallpaper.main_mut().presentation.quality = WallpaperQuality::High;
        let identity = r"\\?\DISPLAY#DEL4026#5&abc#fnv0164deadbeef".to_string();
        config.wallpaper.main_mut().displays = vec![DisplaySelection::Fixed {
            display_id: identity.clone(),
        }];
        let (loaded, migrated) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!migrated);
        assert_eq!(loaded.wallpaper.presentation().brightness, 0.5);
        assert_eq!(loaded.wallpaper.presentation().motion, 0.0);
        assert_eq!(
            loaded.wallpaper.presentation().quality,
            WallpaperQuality::High
        );
        assert_eq!(
            loaded.wallpaper.main().displays,
            vec![DisplaySelection::Fixed {
                display_id: identity
            }]
        );
        assert_eq!(loaded.wallpaper.battery_policy, BatteryPolicy::Pause);
    }

    #[test]
    fn wallpaper_sanitize_uses_fps_tiers_and_bounds_runtime_fields() {
        assert_eq!(fps_tier(75), 60);
        assert_eq!(fps_tier(45), 30);
        assert_eq!(fps_tier(20), 15);
        assert_eq!(fps_tier(8), 15);
        assert_eq!(fps_tier(30), 30);
        let mut wallpaper = LegacyWallpaperConfig {
            fps: 75,
            brightness: 0.1,
            motion: 2.0,
            display_id: Some("  ".into()),
            ..Default::default()
        };
        sanitize_legacy_wallpaper(&mut wallpaper);
        assert_eq!(wallpaper.fps, 60);
        assert_eq!(wallpaper.brightness, 0.25);
        assert_eq!(wallpaper.motion, 1.0);
        assert!(wallpaper.display_id.is_none());
        wallpaper.brightness = f64::NAN;
        wallpaper.motion = f64::NEG_INFINITY;
        wallpaper.display_id = Some(" x ".into());
        sanitize_legacy_wallpaper(&mut wallpaper);
        assert_eq!(wallpaper.brightness, 1.0);
        assert_eq!(wallpaper.motion, 0.0);
        assert_eq!(wallpaper.display_id.as_deref(), Some("x"));
        wallpaper.display_id = Some("y".repeat(257));
        sanitize_legacy_wallpaper(&mut wallpaper);
        assert!(wallpaper.display_id.is_none());
    }

    #[test]
    fn v4_file_without_mini_key_parses_with_defaults() {
        // 接入小窗前的存量文件没有 `mini` 键：serde(default) 兜底，不做 schema 迁移。
        let value = serde_json::json!({"schemaVersion":4,"revision":7,"launchAtLogin":false,
            "activeProfile":null,"profiles":[],"lastCommit":null});
        let (loaded, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated);
        assert_eq!(loaded.mini, MiniConfig::default());
        assert!(loaded.mini.pet);
    }

    #[test]
    fn explicit_capsule_preference_survives_the_new_pet_default() {
        let mut config = Config::default();
        config.activate_profile(profile("capsule")).unwrap();
        config.mini.pet = false;
        let (loaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!loaded.mini.pet);
    }

    #[test]
    fn mini_config_round_trips_and_sanitizes() {
        let mut config = Config::default();
        // 根级 mini 是运行时视图：先激活 profile 把域存进 profiles[] 才会落盘。
        config.activate_profile(profile("a")).unwrap();
        config.mini.pet = true;
        config.mini.edge_hide = true;
        config.mini.geometry.dock = crate::mini::DockEdge::Right;
        config.mini.geometry.along = 0.42;
        let (loaded, migrated) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert!(!migrated);
        assert!(loaded.mini.pet && loaded.mini.edge_hide);
        assert_eq!(loaded.mini.geometry.dock, crate::mini::DockEdge::Right);
        assert!((loaded.mini.geometry.along - 0.42).abs() < 1e-9);
        // 数值护栏：越界 scale/opacity/along 都被夹回。
        let mut mini = MiniConfig {
            scale: 9.0,
            opacity: -1.0,
            ..MiniConfig::default()
        };
        mini.geometry.along = 5.0;
        sanitize_mini(&mut mini);
        assert_eq!(mini.scale, 1.2);
        assert_eq!(mini.opacity, 0.3);
        assert_eq!(mini.geometry.along, 1.0);
    }

    #[test]
    fn v4_rejects_unknown_root_and_wallpaper_fields() {
        let base = serde_json::json!({"schemaVersion":4,"revision":3,"launchAtLogin":false,
            "activeProfile":null,"profiles":[],"lastCommit":null});
        let mut unknown = base.clone();
        unknown["legacySomething"] = 1.into();
        assert!(parse_config(&serde_json::to_vec(&unknown).unwrap()).is_err());
        let mut wallpaper = serde_json::to_value(LegacyWallpaperConfig::default()).unwrap();
        wallpaper["customField"] = 1.into();
        let domain = serde_json::json!({"profile":{"dataDir":r"C:\profiles\a","edition":"full"},"lyrics":LyricsConfig::default(),"wallpaper":wallpaper});
        let value = serde_json::json!({"schemaVersion":4,"revision":3,"launchAtLogin":false,
            "activeProfile":null,"profiles":[domain]});
        assert!(parse_config(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn v4_to_v5_preserves_intent_without_persisting_legacy_fields() {
        let legacy = LegacyWallpaperConfig {
            enabled: true,
            source: "fixed".into(),
            scene: "coast".into(),
            music_response: false,
            monitor: Some(r"\\.\DISPLAY-unplugged".into()),
            brightness: 0.5,
            motion: 0.25,
            ..Default::default()
        };
        let value = serde_json::json!({"schemaVersion":4,"revision":4,"launchAtLogin":false,"activeProfile":null,"profiles":[],
            "unboundDomain":{"lyrics":LyricsConfig::default(),"wallpaper":legacy}});
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated && config.wallpaper.enabled);
        assert_eq!(config.wallpaper.builtin().unwrap().scene_id, "coast");
        assert!(!config.wallpaper.follows_hertz() && !config.wallpaper.responds_to_hertz());
        assert!(
            matches!(&config.wallpaper.main().displays[0], crate::wallpaper::config::DisplaySelection::Unresolved { legacy_name } if legacy_name == r"\\.\DISPLAY-unplugged")
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&encode_config(&config).unwrap()).unwrap();
        let wallpaper = &persisted["unboundDomain"]["wallpaper"];
        for field in [
            "source",
            "scene",
            "monitor",
            "displayId",
            "fps",
            "musicResponse",
        ] {
            assert!(wallpaper.get(field).is_none(), "{field}");
        }
        assert!(!wallpaper["groups"][0]["selection"]["params"]
            .as_object()
            .unwrap()
            .is_empty());
        let (restored, migrated) = parse_config(&serde_json::to_vec(&persisted).unwrap()).unwrap();
        assert!(!migrated);
        assert_eq!(restored.revision, 5);
    }

    #[test]
    fn last_commit_round_trips_through_v4_files() {
        let commit = CommitRef {
            request_id: "eb6d56a1-6316-4a75-92a5-2fb6a0dc1da8".into(),
            payload_digest: "digest".into(),
        };
        let value = serde_json::json!({"schemaVersion":4,"revision":9,"launchAtLogin":false,
            "activeProfile":null,"profiles":[],
            "lastCommit":{"requestId":commit.request_id,"payloadDigest":commit.payload_digest}});
        let (config, migrated) = parse_config(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(migrated);
        assert_eq!(config.last_commit.as_ref().unwrap(), &commit);
        let (reloaded, _) = parse_config(&encode_config(&config).unwrap()).unwrap();
        assert_eq!(reloaded.last_commit.as_ref().unwrap(), &commit);
    }
}

#[cfg(test)]
mod journal_integration_tests {
    use super::*;
    use crate::wallpaper::library::tempfileish;

    #[test]
    fn named_replay_after_a_later_commit_never_swaps_old_intent_into_memory() {
        let dir = tempfileish::temp_dir("config-named-replay");
        let mut current = Config::default();
        save_at(&current, dir.path()).unwrap();
        let mut next = current.clone();
        next.wallpaper.enabled = true;
        let mut intent =
            crate::config_journal::Intent::internal(&encode_config(&next).unwrap()).unwrap();
        intent.command = "wallpaper.apply".into();
        let first = commit_named_at(&mut current, next.clone(), dir.path(), &intent).unwrap();
        assert_eq!(first.config_revision, Some(2));
        let mut later = current.clone();
        later.wallpaper.enabled = false;
        commit_at(&mut current, later, dir.path()).unwrap();
        let bytes = std::fs::read(dir.path().join("config.json")).unwrap();
        let replay = commit_named_at(&mut current, next, dir.path(), &intent).unwrap();
        assert_eq!(replay.config_revision, first.config_revision);
        assert_eq!(current.revision, 3);
        assert!(!current.wallpaper.enabled);
        assert_eq!(
            std::fs::read(dir.path().join("config.json")).unwrap(),
            bytes
        );
        assert_eq!(
            current.last_commit,
            parse_config(&bytes).unwrap().0.last_commit
        );
    }
}
