// SPDX-License-Identifier: MIT
//! Match the application's distribution, rather than GitHub's global latest release.
use serde::{Deserialize, Serialize};

use super::{Failure, MAX_PACKAGE_BYTES};

pub(super) const REPOSITORY: &str = "https://github.com/onceMisery/hertz-studio";
pub(super) const RELEASES_API: &str =
    "https://api.github.com/repos/onceMisery/hertz-studio/releases?per_page=100";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Distribution {
    Standalone,
    Plugin,
}

impl Distribution {
    fn tag_prefix(self, edition: &str) -> &'static str {
        match (self, edition) {
            (Self::Standalone, _) => "hertz-studio-v",
            (Self::Plugin, "full") => "hertz-plugin-full-v",
            (Self::Plugin, _) => "hertz-plugin-standard-v",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    Installer,
    Portable,
}

#[derive(Clone, Debug)]
pub(super) struct Context {
    pub version: String,
    pub edition: String,
    pub distribution: Distribution,
    pub target: String,
    pub install_kind: Option<InstallKind>,
}

impl Context {
    pub fn compiled(distribution: Distribution, install_kind: Option<InstallKind>) -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").into(),
            edition: crate::edition::NAME.into(),
            distribution,
            target: env!("HERTZ_BUILD_TARGET").into(),
            install_kind,
        }
    }
}

/// Only stable release tags are eligible; a stable build supersedes its preview.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Version {
    core: [u64; 3],
    stable: bool,
}

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > 96 || text.is_empty() {
            return None;
        }
        let (base, metadata) = text.split_once('+').unwrap_or((text, ""));
        if text.contains('+') && !valid_identifiers(metadata, false) {
            return None;
        }
        let (core, preview) = base.split_once('-').unwrap_or((base, ""));
        if base.contains('-') && !valid_identifiers(preview, true) {
            return None;
        }
        let mut parts = core.split('.');
        let mut numbers = [0; 3];
        for number in &mut numbers {
            let part = parts.next()?;
            if part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            *number = part.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            core: numbers,
            stable: preview.is_empty(),
        })
    }

    pub fn stable(text: &str) -> Option<Self> {
        let version = Self::parse(text)?;
        (version.stable && !text.contains('+')).then_some(version)
    }
}

fn valid_identifiers(text: &str, reject_numeric_zeroes: bool) -> bool {
    !text.is_empty()
        && text.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !(reject_numeric_zeroes
                    && part.len() > 1
                    && part.starts_with('0')
                    && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
}

#[derive(Debug, Deserialize)]
pub(super) struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    pub version: String,
    pub title: String,
    pub notes: String,
    pub release_url: String,
    pub download_url: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<u64>,
}

#[derive(Clone, Debug)]
pub(super) struct Candidate {
    pub view: ReleaseView,
    pub asset: Option<Asset>,
}

#[derive(Clone, Debug)]
pub(super) struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub checksum_url: Option<String>,
}

impl Asset {
    pub fn has_checksum(&self) -> bool {
        self.sha256.is_some() || self.checksum_url.is_some()
    }
}

pub(super) fn select(
    releases: Vec<GithubRelease>,
    context: &Context,
) -> Result<Option<Candidate>, Failure> {
    if releases.len() > 100 {
        return Err(Failure::new("update_feed_invalid", "发布列表超过允许范围"));
    }
    let prefix = context.distribution.tag_prefix(&context.edition);
    let latest = releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let version = Version::stable(release.tag_name.strip_prefix(prefix)?)?;
            Some((version, release))
        })
        .max_by_key(|(version, _)| *version);
    let Some((_, release)) = latest else {
        return Ok(None);
    };
    if release.assets.len() > 64 {
        return Err(Failure::new("update_feed_invalid", "发布附件超过允许范围"));
    }
    let version = release.tag_name.strip_prefix(prefix).unwrap().to_string();
    let names = asset_names(context, &version);
    let matches: Vec<_> = release
        .assets
        .iter()
        .filter(|asset| names.contains(&asset.name))
        .collect();
    if matches.len() > 1 {
        return Err(Failure::new(
            "update_feed_invalid",
            "发布包身份不唯一，请查看发布页面",
        ));
    }
    let asset = matches
        .first()
        .filter(|asset| asset.size > 0 && asset.size <= MAX_PACKAGE_BYTES)
        .filter(|asset| asset.browser_download_url == asset_url(&release.tag_name, &asset.name))
        .map(|asset| {
            let checksum_name = format!("{}.sha256", asset.name);
            let checksum = release
                .assets
                .iter()
                .find(|item| item.name == checksum_name || item.name == "SHA256SUMS.txt")
                .filter(|item| item.size <= 16 * 1024)
                .filter(|item| {
                    item.browser_download_url == asset_url(&release.tag_name, &item.name)
                });
            Asset {
                name: asset.name.clone(),
                url: asset.browser_download_url.clone(),
                size: asset.size,
                sha256: asset.digest.as_deref().and_then(parse_digest),
                checksum_url: checksum.map(|item| item.browser_download_url.clone()),
            }
        });
    Ok(Some(Candidate {
        view: ReleaseView {
            version,
            title: bounded_text(release.name.as_deref().unwrap_or("Hertz Studio"), 256),
            notes: bounded_text(
                release.body.as_deref().unwrap_or("此版本未提供更新说明"),
                16 * 1024,
            ),
            release_url: format!("{REPOSITORY}/releases/tag/{}", release.tag_name),
            download_url: asset.as_ref().map(|asset| asset.url.clone()),
            file_name: asset.as_ref().map(|asset| asset.name.clone()),
            size: asset.as_ref().map(|asset| asset.size),
        },
        asset,
    }))
}

fn asset_names(context: &Context, version: &str) -> Vec<String> {
    if context.distribution == Distribution::Plugin {
        let platform = match context.target.as_str() {
            "x86_64-pc-windows-msvc" => "windows-x64",
            "aarch64-apple-darwin" => "darwin-arm64",
            "x86_64-apple-darwin" => "darwin-x64",
            "x86_64-unknown-linux-gnu" => "linux-x64",
            "aarch64-unknown-linux-gnu" => "linux-arm64",
            _ => return Vec::new(),
        };
        let suffix = if context.edition == "full" {
            ".full"
        } else {
            ""
        };
        return vec![format!(
            "io.github.oncemisery.hertz-studio{suffix}-{version}-{platform}.dbxp"
        )];
    }
    let extension = if context.target == "x86_64-pc-windows-msvc" {
        if context.install_kind == Some(InstallKind::Installer) {
            "-setup.exe"
        } else {
            ".zip"
        }
    } else {
        ".tar.gz"
    };
    if context.edition == "full" {
        vec![
            format!("hertz-studio-{version}-{}{extension}", context.target),
            format!("hertz-studio-full-{version}-{}{extension}", context.target),
        ]
    } else {
        vec![format!(
            "hertz-studio-standard-{version}-{}{extension}",
            context.target
        )]
    }
}

fn asset_url(tag: &str, name: &str) -> String {
    format!("{REPOSITORY}/releases/download/{tag}/{name}")
}

pub(super) fn parse_digest(text: &str) -> Option<String> {
    let hex = text.strip_prefix("sha256:")?;
    valid_hash(hex).then(|| hex.to_ascii_lowercase())
}

pub(super) fn valid_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn parse_checksum(text: &str, name: &str) -> Result<String, Failure> {
    let mut matches = text.lines().filter_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && parts.next().is_none() && valid_hash(hash))
            .then(|| hash.to_ascii_lowercase())
    });
    let hash = matches.next().ok_or_else(|| {
        Failure::new(
            "update_checksum_missing",
            "更新包缺少匹配的 SHA-256，请查看发布页面",
        )
    })?;
    if matches.next().is_some() {
        return Err(Failure::new("update_checksum_invalid", "更新包摘要不唯一"));
    }
    Ok(hash)
}

fn bounded_text(text: &str, maximum: usize) -> String {
    let mut length = text.len().min(maximum);
    while !text.is_char_boundary(length) {
        length -= 1;
    }
    text[..length].to_owned()
}

pub(super) fn allowed_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}
