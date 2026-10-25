// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 唯一的桌面配置。持久配置表达用户意图；窗口/来源运行事实另行查询。

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) launch_at_login: bool,
    pub(crate) active_profile: Option<Profile>,
    pub(crate) lyrics: LyricsConfig,
    #[serde(default)]
    pub(crate) wallpaper: WallpaperConfig,
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
            schema_version: SCHEMA_VERSION,
            revision: 1,
            launch_at_login: false,
            active_profile: None,
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
        let lyrics = &mut self.lyrics;
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
        let wallpaper = &mut self.wallpaper;
        wallpaper.fps = wallpaper.fps.clamp(15, 60);
        wallpaper.monitor = wallpaper
            .monitor
            .take()
            .map(|monitor| monitor.trim().to_string())
            .filter(|monitor| !monitor.is_empty());
    }
}

fn valid_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
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
    let mut config: Config = serde_json::from_slice(&bytes)
        .with_context(|| format!("解析 {}（坏配置原样保留，未覆盖）", path.display()))?;
    if config.schema_version != SCHEMA_VERSION {
        anyhow::bail!(
            "{} 的 schemaVersion={}，本组件只支持 {SCHEMA_VERSION}（文件未改动）",
            path.display(),
            config.schema_version
        );
    }
    config.sanitize();
    Ok(config)
}

pub(crate) fn save(config: &Config) -> Result<()> {
    let dir = base_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("创建 {}", dir.display()))?;
    let path = config_path();
    let tmp = dir.join("config.json.tmp");
    let bytes = serde_json::to_vec_pretty(config)?;
    std::fs::write(&tmp, bytes).with_context(|| format!("写入 {}", tmp.display()))?;
    crate::native::replace_file(&tmp, &path).with_context(|| format!("替换 {}", path.display()))?;
    Ok(())
}

/// 首次启动自动选一个 profile：只读两个规范数据目录，不扫描端口。
pub(crate) fn detect_profile() -> Option<Profile> {
    let base = dirs::data_local_dir()?;
    let mut candidates = Vec::new();
    for (edition, dir) in [
        ("full", base.join("hertz-studio")),
        ("standard", base.join("hertz-studio-standard")),
    ] {
        let discovery = dir.join("vmusicd.json");
        let Ok(meta) = std::fs::metadata(&discovery) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        candidates.push((
            modified,
            Profile {
                data_dir: dir,
                edition: edition.into(),
            },
        ));
    }
    candidates
        .into_iter()
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, profile)| profile)
}
