// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

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
    pub ai: AiConfig,
    pub log: LogConfig,
}

/// Non-secret provider selection. Model requests still require the separate
/// generation consent setting. Changes take effect on service restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AiConfig {
    pub provider: String,
    pub origin: String,
    pub model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "fake".into(),
            origin: "http://127.0.0.1:11434".into(),
            model: String::new(),
        }
    }
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
                port: if crate::edition::FULL { 7634 } else { 7635 },
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
            ai: AiConfig::default(),
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
            // Never replace an explicitly selected provider with the default
            // after a syntax/shape error. Report the file, without echoing its
            // possibly sensitive contents through a TOML diagnostic.
            toml::from_str(&raw)
                .map_err(|_| anyhow::anyhow!("invalid configuration file: {}", path.display()))?
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
        .join(crate::edition::DATA_DIR)
}

/// 项目原名 `mmusic-studio`（仓库旧名），数据目录也叫过这个。改名后旧目录里是
/// 曲库、歌词、登录 cookie、token 与插件 sidecar 的全部状态——必须在任何读写路径
/// 之前把它整体搬到新名下，否则用户看到的就是一座空库。
///
/// 只在「新目录不存在且旧目录存在」时动一次 rename（原子、不复制不删）；两边都在
/// 说明用户自己开过新目录，不碰。显式设了 `VMUSIC_DATA_DIR` 时同样不碰。
pub fn migrate_legacy_data_dir() {
    if !crate::edition::FULL || std::env::var_os("VMUSIC_DATA_DIR").is_some() {
        return;
    }
    let Some(base) = dirs::data_local_dir() else {
        return;
    };
    let legacy = base.join("mmusic-studio");
    let current = base.join("hertz-studio");
    if !legacy.is_dir() || current.exists() {
        return;
    }
    match std::fs::rename(&legacy, &current) {
        Ok(()) => tracing::info!(
            from = %legacy.display(),
            to = %current.display(),
            "数据目录已搬到新名字下"
        ),
        // 搬不动就照旧跑：新目录会被创建成空库，但这条必须让人看得见——
        // 调用点可能在日志订阅器装好之前，所以直接写 stderr（sidecar 的协议
        // 走 stdout，写 stderr 安全）。
        Err(error) => {
            tracing::error!(
                from = %legacy.display(),
                to = %current.display(),
                %error,
                "数据目录改名失败，请手动把旧目录迁移到新名字"
            );
            eprintln!(
                "[hertz-studio] 数据目录改名失败：{} → {}（{error}），请手动迁移",
                legacy.display(),
                current.display()
            );
        }
    }
}

#[cfg(test)]
mod ai_config_tests {
    use super::*;

    #[test]
    fn provider_configuration_defaults_and_roundtrips_without_secrets() {
        let default: Config = toml::from_str("").unwrap();
        assert_eq!(default.ai.provider, "fake");
        assert!(default.ai.model.is_empty());
        let configured: Config = toml::from_str(
            "[ai]\nprovider='ollama'\norigin='http://[::1]:11434'\nmodel='test:local'\n",
        )
        .unwrap();
        let roundtrip: Config = toml::from_str(&toml::to_string(&configured).unwrap()).unwrap();
        assert_eq!(roundtrip.ai.provider, "ollama");
        assert_eq!(roundtrip.ai.model, "test:local");
        assert!(toml::from_str::<Config>("[ai]\napi_key='secret'\n").is_err());
    }

    #[test]
    fn malformed_file_is_an_error_without_echoing_contents() {
        let dir = std::env::temp_dir().join(format!("hertz-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "[ai]\nprovider='ollama'\napi_key='private-sentinel'\n",
        )
        .unwrap();
        let error = Config::load(&dir).unwrap_err().to_string();
        assert!(error.contains("invalid configuration file"));
        assert!(!error.contains("private-sentinel"));
        std::fs::remove_file(dir.join("config.toml")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
