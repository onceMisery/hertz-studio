// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面 surface 共用的发现、窄凭据与本机只读 HTTP。
//!
//! 歌词和壁纸各自有独立钥匙与路由组，但「读发现、读钥匙、有界 GET」只有
//! 这一份。两套 feed 不复制超时、重定向和响应体上限。

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::config::Profile;

pub(crate) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct Discovery {
    #[allow(dead_code)]
    pub(crate) pid: u32,
    pub(crate) port: u16,
    #[allow(dead_code)]
    pub(crate) version: String,
    #[allow(dead_code)]
    pub(crate) protocol_version: u32,
    #[serde(default)]
    pub(crate) edition: Option<String>,
    #[serde(default)]
    pub(crate) server_instance_id: Option<String>,
    #[serde(default)]
    pub(crate) desktop_lyrics_protocol: Option<u32>,
    #[serde(default)]
    pub(crate) wallpaper_protocol: Option<u32>,
}

pub(crate) fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("创建本机 HTTP 客户端")
}

pub(crate) fn read_discovery(profile: &Profile) -> Result<Discovery> {
    let path = profile.data_dir.join("vmusicd.json");
    let bytes = std::fs::read(&path).with_context(|| {
        format!(
            "未找到 {}：请先启动 Hertz {} 服务",
            path.display(),
            profile.edition
        )
    })?;
    if bytes.len() > 64 * 1024 {
        bail!("{} 超过 64 KiB，拒绝读取", path.display());
    }
    serde_json::from_slice(&bytes).with_context(|| format!("解析 {}", path.display()))
}

pub(crate) fn read_key(data_dir: &Path, name: &str, label: &str) -> Result<String> {
    let path: PathBuf = data_dir.join(name);
    let key = std::fs::read_to_string(&path)
        .with_context(|| {
            format!(
                "未找到 {}：请重启 Hertz 服务以生成{label}钥匙",
                path.display()
            )
        })?
        .trim()
        .to_string();
    if key.len() < 32
        || key.len() > 128
        || !key.chars().all(|character| character.is_ascii_hexdigit())
    {
        bail!("{} 不是有效的{label}钥匙", path.display());
    }
    Ok(key)
}

pub(crate) fn get_json<T: DeserializeOwned>(
    client: &reqwest::blocking::Client,
    base: &str,
    path: &str,
    scheme: &str,
    key: &str,
) -> Result<T> {
    if key.is_empty() {
        return Err(anyhow!("只读钥匙为空"));
    }
    let response = client
        .get(format!("{base}{path}"))
        .header("Authorization", format!("{scheme} {key}"))
        .send()
        .with_context(|| format!("连接本机服务失败（{path}）"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        let snippet = body.chars().take(160).collect::<String>();
        bail!("服务返回 {status}（{path}）：{snippet}");
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_BODY_BYTES {
            bail!("服务响应超过 {MAX_BODY_BYTES} 字节上限");
        }
    }
    let body = response.text().context("读取服务响应")?;
    if body.len() > MAX_BODY_BYTES {
        bail!("服务响应超过 {MAX_BODY_BYTES} 字节上限");
    }
    serde_json::from_str(&body).with_context(|| format!("解析服务响应（{path}）"))
}
