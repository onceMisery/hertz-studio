// SPDX-License-Identifier: MIT
//! HTTPS transport distinct from the original paired loopback AI connection.
//! Resolve once per request, reject private destinations, pin all connection
//! addresses, keep TLS names/certificates, and reject redirects/proxies/encoding.
use super::{
    contract, error,
    model::{AuthProfile, SourceProfile},
    AcceptedRelease,
};
use crate::wallpaper::{assets::SnapshotReceipt, jobs::JobError};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(crate) fn canonical_origin(value: &str) -> Result<String, JobError> {
    if value.len() > 2048 {
        return Err(error("invalid_origin", "社区 origin 过长"));
    }
    let url = https(value)?;
    if url.path() != "/" || url.query().is_some() {
        return Err(error("invalid_origin", "社区来源应只包含 HTTPS origin"));
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn https(value: &str) -> Result<reqwest::Url, JobError> {
    let url = reqwest::Url::parse(value).map_err(|_| error("invalid_url", "HTTPS 地址无效"))?;
    if value.len() > 4096
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(error("invalid_url", "社区请求必须使用无凭据的 HTTPS 地址"));
    }
    Ok(url)
}

pub(crate) async fn client(
    destination: &str,
    total: Duration,
) -> Result<(reqwest::Client, reqwest::Url), JobError> {
    let url = https(destination)?;
    let host = url
        .host_str()
        .ok_or_else(|| error("invalid_url", "目标缺少主机"))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let pinned = super::network_policy::addresses(&url)?;
    let administrator_pinned = pinned.is_some();
    let addresses: Vec<SocketAddr> = if let Some(pinned) = pinned {
        pinned
    } else if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| error("community_timeout", "社区 DNS 超时"))?
        .map_err(|_| error("community_network", "社区 DNS 无法解析"))?
        .take(17)
        .collect()
    };
    if addresses.is_empty()
        || addresses.len() > 16
        || !administrator_pinned && addresses.iter().any(|a| !public(a.ip()))
    {
        return Err(error(
            "community_destination",
            "社区连接目标必须是公网地址或管理员固定的确切地址",
        ));
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .timeout(total)
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| error("community_network", "无法建立受限 HTTPS 客户端"))?;
    Ok((client, url))
}

pub(crate) async fn get(destination: &str, maximum: usize) -> Result<Vec<u8>, JobError> {
    let (client, url) = client(destination, Duration::from_secs(15)).await?;
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| error("community_network", "社区请求失败"))?;
    bounded(response, maximum).await
}

pub(crate) async fn authenticated_get(
    destination: &str,
    token: &str,
    maximum: usize,
) -> Result<Vec<u8>, JobError> {
    let (client, url) = client(destination, Duration::from_secs(15)).await?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| error("community_network", "已认证社区请求失败"))?;
    bounded(response, maximum).await
}

pub(crate) async fn bounded(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<Vec<u8>, JobError> {
    if response.status() != reqwest::StatusCode::OK {
        return Err(error("community_response", "社区响应状态无效"));
    }
    identity(&response)?;
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err(error("community_response_limit", "社区响应超过合同上限"));
    }
    let mut bytes = Vec::with_capacity(maximum.min(65536));
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("community_network", "社区响应中断"))?
    {
        if chunk.len() > 65536 || bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(error(
                "community_response_limit",
                "社区响应超过有界读取上限",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    hertz_wallpaper::json::check_bounded_json(&bytes, 16).map_err(contract)?;
    Ok(bytes)
}

fn identity(response: &reqwest::Response) -> Result<(), JobError> {
    if response
        .headers()
        .get_all("content-encoding")
        .iter()
        .any(|v| v.as_bytes() != b"identity")
    {
        return Err(error("community_encoding", "社区响应不能使用隐式压缩"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Discovery {
    hub_id: String,
    origin: String,
    issuer: String,
    client_id: String,
    audience: String,
    scopes: Vec<String>,
    allowed_signing_algorithms: Vec<String>,
    root_fingerprint: String,
    protocol_version: u32,
    author_web_enabled: bool,
}

pub(crate) async fn discover(origin: &str) -> Result<(SourceProfile, Vec<u8>), JobError> {
    let origin = canonical_origin(origin)?;
    let bytes = get(&format!("{origin}/v1/auth/config"), 65536).await?;
    let discovery: Discovery = serde_json::from_slice(&bytes)
        .map_err(|_| error("community_discovery", "社区发现配置无效"))?;
    if discovery.origin != origin || discovery.protocol_version != 1 || discovery.author_web_enabled
    {
        return Err(error("community_discovery", "社区来源或协议资格不匹配"));
    }
    let chain = get(
        &format!("{origin}/v1/keys"),
        hertz_wallpaper::release::authorization::MAX_AUTHORIZATION_BYTES,
    )
    .await?;
    let parsed = hertz_wallpaper::release::authorization::AuthorizationChain::parse(&chain)
        .map_err(contract)?;
    let fingerprint = parsed.bootstrap_root.fingerprint().map_err(contract)?;
    if fingerprint != discovery.root_fingerprint
        || parsed
            .authorizations
            .first()
            .is_none_or(|a| a.authorization.hub_id != discovery.hub_id)
    {
        return Err(error("community_discovery", "根公钥和发现身份不匹配"));
    }
    let profile = SourceProfile {
        source_id: uuid::Uuid::new_v4().to_string(),
        origin,
        hub_id: discovery.hub_id,
        root_fingerprint: fingerprint,
        auth: AuthProfile {
            issuer: discovery.issuer,
            client_id: discovery.client_id,
            audience: discovery.audience,
            scopes: discovery.scopes,
            algorithms: discovery.allowed_signing_algorithms,
        },
    };
    profile.validate()?;
    Ok((profile, chain))
}

pub(crate) async fn safety(profile: &SourceProfile) -> Result<(Vec<u8>, Vec<u8>), JobError> {
    profile.validate()?;
    let chain = get(
        &format!("{}/v1/keys", profile.origin),
        hertz_wallpaper::release::authorization::MAX_AUTHORIZATION_BYTES,
    )
    .await?;
    let rev = get(
        &format!("{}/v1/revocations", profile.origin),
        hertz_wallpaper::release::MAX_REVOCATIONS_BYTES,
    )
    .await?;
    Ok((chain, rev))
}

pub(crate) async fn latest(profile: &SourceProfile, work: &str) -> Result<Vec<u8>, JobError> {
    canonical_uuid(work)?;
    get(
        &format!("{}/v1/works/{work}/release", profile.origin),
        hertz_wallpaper::release::MAX_RELEASE_BYTES,
    )
    .await
}

pub(crate) fn canonical_uuid(value: &str) -> Result<(), JobError> {
    if uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() != value)
        .unwrap_or(true)
    {
        return Err(error("invalid_identity", "需要规范 UUID 身份"));
    }
    Ok(())
}

pub(crate) async fn download(
    release: &AcceptedRelease,
    job: &str,
    target: &Path,
    cancel: &AtomicBool,
) -> Result<SnapshotReceipt, JobError> {
    let body = release.body();
    if body.bytes > 512 * 1024 * 1024 {
        return Err(error("package_limit", "社区包超过 512 MiB 上限"));
    }
    let destination = format!(
        "{}/v1/works/{}/releases/{}/package",
        release.origin(),
        body.work_id,
        body.release_id
    );
    let (client, url) = client(&destination, Duration::from_secs(1800)).await?;
    let mut response = client
        .get(url)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| error("community_network", "社区包下载失败"))?;
    if response.status() != reqwest::StatusCode::OK || response.content_length() != Some(body.bytes)
    {
        return Err(error(
            "release_package_mismatch",
            "社区包状态或确切长度不一致",
        ));
    }
    identity(&response)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| JobError::io(e.to_string()))?;
    let mut count = 0u64;
    let mut sha = Sha256::new();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(error("cancelled", "社区下载已取消"));
        }
        let read = response.chunk();
        tokio::pin!(read);
        let next = loop {
            tokio::select! {
                result=&mut read=>break result.map_err(|_|error("community_network","社区包流中断"))?,
                _=tokio::time::sleep(Duration::from_millis(50))=>if cancel.load(Ordering::Acquire){return Err(error("cancelled","社区下载已取消"));}
            }
        };
        let Some(chunk) = next else {
            break;
        };
        if chunk.len() > 65536 || count.saturating_add(chunk.len() as u64) > body.bytes {
            return Err(error(
                "release_package_mismatch",
                "社区包流超过长度或流片上限",
            ));
        }
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| JobError::io(e.to_string()))?;
        sha.update(&chunk);
        count += chunk.len() as u64;
    }
    let hash = format!("{:x}", sha.finalize());
    if count != body.bytes || hash != body.package_hash {
        return Err(error(
            "release_package_mismatch",
            "社区包完整 SHA256 或长度不匹配",
        ));
    }
    file.sync_all().map_err(|e| JobError::io(e.to_string()))?;
    Ok(SnapshotReceipt {
        job_id: job.to_owned(),
        original: target.to_path_buf(),
        bytes: count,
        sha256: hash,
    })
}

fn public(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v)),
        v => v,
    };
    if let IpAddr::V6(v) = ip {
        if v.segments()[0] & 0xe000 != 0x2000 {
            return false;
        }
    }
    const DENIED: &[&str] = &[
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/3",
        "2001::/32",
        "2001:10::/28",
        "2001:db8::/32",
        "2002::/16",
    ];
    !DENIED
        .iter()
        .any(|s| s.parse::<ipnet::IpNet>().is_ok_and(|n| n.contains(&ip)))
}
