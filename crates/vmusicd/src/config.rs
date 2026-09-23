// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Configuration: defaults, then `config.toml`, then `VMUSIC_*` env vars.
//!
//! `figment` would do this in one call, but a hand-rolled merge keeps the
//! dependency list small and makes the precedence obvious to readers.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub audio: AudioConfig,
    pub library: LibraryConfig,
    pub online: OnlineConfig,
    pub log: LogConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub bind: String,
    /// 0 means "pick a free port and write it to the discovery file".
    pub port: u16,
    pub expose_ui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    pub backend: String,
    pub volume: f32,
    pub spectrum_bands: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryConfig {
    pub extensions: Vec<String>,
    pub follow_symlinks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OnlineConfig {
    /// 在线音频缓存上限（字节），默认 2 GiB。
    pub cache_max_bytes: u64,
}

impl Default for OnlineConfig {
    fn default() -> Self {
        Self {
            cache_max_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogConfig {
    pub level: String,
    pub format: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                bind: "127.0.0.1".into(),
                port: 7634,
                expose_ui: true,
            },
            audio: AudioConfig {
                backend: "cpal".into(),
                volume: 0.8,
                spectrum_bands: 64,
            },
            library: LibraryConfig {
                extensions: vmusic_library::AUDIO_EXTENSIONS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                follow_symlinks: false,
            },
            online: OnlineConfig::default(),
            log: LogConfig {
                level: "info".into(),
                format: "pretty".into(),
            },
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Config::default().server
    }
}
impl Default for AudioConfig {
    fn default() -> Self {
        Config::default().audio
    }
}
impl Default for LibraryConfig {
    fn default() -> Self {
        Config::default().library
    }
}
impl Default for LogConfig {
    fn default() -> Self {
        Config::default().log
    }
}

impl Config {
    /// Loads from `data_dir/config.toml` (creating the file with defaults when
    /// absent) and then applies environment overrides.
    pub fn load(data_dir: &Path) -> anyhow::Result<Self> {
        let path = data_dir.join("config.toml");
        let mut config = if path.is_file() {
            let raw = std::fs::read_to_string(&path)?;
            toml::from_str(&raw).unwrap_or_else(|e| {
                tracing::warn!("ignoring malformed {}: {e}", path.display());
                Config::default()
            })
        } else {
            let config = Config::default();
            if let Ok(text) = toml::to_string_pretty(&config) {
                let _ = std::fs::write(&path, text);
            }
            config
        };

        if let Ok(v) = std::env::var("VMUSIC_BIND") {
            config.server.bind = v;
        }
        if let Ok(v) = std::env::var("VMUSIC_PORT") {
            config.server.port = v.parse().unwrap_or(config.server.port);
        }
        if let Ok(v) = std::env::var("VMUSIC_BACKEND") {
            config.audio.backend = v;
        }
        if let Ok(v) = std::env::var("VMUSIC_LOG") {
            config.log.level = v;
        }
        config.audio.volume = config.audio.volume.clamp(0.0, 1.0);
        Ok(config)
    }
}

/// Platform-appropriate data directory.
pub fn default_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("VMUSIC_DATA_DIR") {
        return PathBuf::from(v);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mmusic-studio")
}
