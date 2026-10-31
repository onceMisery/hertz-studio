// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面 surface 共用的发现、窄凭据与本机只读 HTTP。
//!
//! 歌词和壁纸各自有独立钥匙与路由组，但「读发现、读钥匙、有界 GET」只有
//! 这一份。两套 feed 不复制超时、重定向和响应体上限。

use std::io::Read;
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
    if crate::config::is_dbx(profile) {
        bail!("DBX 来源不支持 HTTP 发现");
    }
    let path = std::path::Path::new(profile.data_dir()).join("vmusicd.json");
    let bytes = std::fs::File::open(&path)
        .map_err(anyhow::Error::from)
        .and_then(|file| read_bounded(file, 64 * 1024))
        .with_context(|| {
            format!(
                "未找到 {}：请先启动 Hertz {} 服务",
                path.display(),
                profile.edition()
            )
        })?;
    serde_json::from_slice(&bytes).with_context(|| format!("解析 {}", path.display()))
}

pub(crate) fn read_key(data_dir: &Path, name: &str, label: &str) -> Result<String> {
    let path: PathBuf = data_dir.join(name);
    let key = std::fs::File::open(&path)
        .map_err(anyhow::Error::from)
        .and_then(|file| read_bounded(file, 130))
        .and_then(|bytes| String::from_utf8(bytes).map_err(anyhow::Error::from))
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
        let body = read_bounded(response, 1024)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        let snippet = body.chars().take(160).collect::<String>();
        bail!("服务返回 {status}（{path}）：{snippet}");
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_BODY_BYTES {
            bail!("服务响应超过 {MAX_BODY_BYTES} 字节上限");
        }
    }
    let body = read_bounded(response, MAX_BODY_BYTES).context("读取服务响应")?;
    serde_json::from_slice(&body).with_context(|| format!("解析服务响应（{path}）"))
}

fn read_bounded(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        bail!("数据超过 {limit} 字节上限");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_reject_oversize_without_consuming_the_entire_input() {
        let mut input = std::io::Cursor::new(vec![b'a'; 4096]);
        assert!(read_bounded(&mut input, 128).is_err());
        assert_eq!(input.position(), 129);
        assert_eq!(read_bounded(&b"exact"[..], 5).unwrap(), b"exact");
    }
}
