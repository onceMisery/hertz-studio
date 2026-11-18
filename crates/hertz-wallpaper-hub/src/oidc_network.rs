// SPDX-License-Identifier: MIT
//! The login caller never supplies discovery/JWKS destinations. Resolve and pin
//! every connection; environment HTTP proxies cannot bypass this address check.
use crate::{
    config::{https_url, Config},
    error::{HubError, Result},
};
use std::net::{IpAddr, SocketAddr};

pub(crate) async fn fetch(config: &Config, destination: &str) -> Result<Vec<u8>> {
    let url = https_url(destination)?;
    let issuer = https_url(&config.issuer)?;
    let host = url.host_str().ok_or_else(HubError::unavailable)?;
    let fixed = url.origin() == issuer.origin() && !config.oidc_fixed_addresses.is_empty();
    let addresses: Vec<SocketAddr> = if fixed {
        config
            .oidc_fixed_addresses
            .iter()
            .map(|ip| SocketAddr::new(*ip, 443))
            .collect()
    } else {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::lookup_host((host, 443)),
        )
        .await
        .map_err(|_| HubError::unavailable())?
        .map_err(|_| HubError::unavailable())?
        .take(17)
        .collect()
    };
    if addresses.is_empty()
        || addresses.len() > 16
        || (!fixed && addresses.iter().any(|address| !public(address.ip())))
    {
        return Err(HubError::unavailable());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .gzip(false)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| HubError::unavailable())?;
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| HubError::unavailable())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|bytes| bytes > 65_536)
    {
        return Err(HubError::unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| HubError::unavailable())?
    {
        if bytes.len().saturating_add(chunk.len()) > 65_536 {
            return Err(HubError::unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    hertz_wallpaper::json::check_bounded_json(&bytes, 12).map_err(|_| HubError::unavailable())?;
    Ok(bytes)
}

fn public(ip: IpAddr) -> bool {
    // Include transition/documentation ranges: a nominally global address can
    // otherwise tunnel an OIDC request to a private endpoint.
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
    let ip = match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        other => other,
    };
    if let IpAddr::V6(ip) = ip {
        if ip.segments()[0] & 0xe000 != 0x2000 {
            return false;
        }
    }
    !DENIED.iter().any(|range| {
        range
            .parse::<ipnet::IpNet>()
            .is_ok_and(|range| range.contains(&ip))
    })
}
