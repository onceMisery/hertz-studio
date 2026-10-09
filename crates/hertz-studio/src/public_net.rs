// SPDX-License-Identifier: MIT

//! 用户提供的公网资源地址共用的 URL、DNS 和重定向边界。
//! DNS 返回值经检查后直接交给连接器，避免检查后再次解析。

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, Url};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SchemePolicy {
    HttpOrHttps,
    HttpsOnly,
}

const MAX_REDIRECTS: usize = 5;

pub(crate) fn public_url(input: &str, scheme: SchemePolicy) -> Result<Url, &'static str> {
    let input = input.trim();
    let invalid = match scheme {
        SchemePolicy::HttpOrHttps => "only public HTTP(S) URLs without credentials are allowed",
        SchemePolicy::HttpsOnly => "only public HTTPS URLs without credentials are allowed",
    };
    if input.len() > 8192 || input.chars().any(char::is_control) {
        return Err(invalid);
    }
    let mut url = Url::parse(input).map_err(|_| invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || (scheme == SchemePolicy::HttpsOnly && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port() == Some(0)
    {
        return Err(invalid);
    }
    let host = url.host_str().ok_or(invalid)?.to_owned();
    let host = host.trim_end_matches('.');
    let address = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = address.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err(invalid);
        }
    } else {
        let host = host.to_ascii_lowercase();
        if !host.contains('.')
            || [
                "localhost",
                "local",
                "internal",
                "lan",
                "home",
                "test",
                "invalid",
            ]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
        {
            return Err(invalid);
        }
        url.set_host(Some(&host)).map_err(|_| invalid)?;
    }
    // URL 自身规范化大小写、默认端口与点路径；fragment 不属于 HTTP 资源身份。
    url.set_fragment(None);
    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127)
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && ((b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99) || b == 168))
                || (a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(ip));
            }
            let s = ip.segments();
            // 仅全球单播 2000::/3，排除协议保留、文档与能封装内网 IPv4 的 6to4。
            // NAT64、ULA、link-local、loopback、multicast 均不在此范围内。
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn public_addresses(addrs: Vec<SocketAddr>) -> io::Result<Vec<SocketAddr>> {
    if addrs.is_empty() || addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "public URL resolved to a local or special-use address",
        ));
    }
    Ok(addrs)
}

struct PublicDns;

impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        let name = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            let addrs = public_addresses(addrs)?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn redirect_target(url: &Url, previous: usize, scheme: SchemePolicy) -> Result<(), &'static str> {
    if previous > MAX_REDIRECTS {
        return Err("too many public URL redirects");
    }
    public_url(url.as_str(), scheme).map(|_| ())
}

/// 首跳必须先经同一 scheme 的 `public_url`；IP 字面量不经过 reqwest 的 DNS 解析器。
/// RSS、音频与图片复用安全策略；读取体积和领域错误由各调用方持有。
pub(crate) fn client(scheme: SchemePolicy) -> Result<Client, &'static str> {
    static HTTP: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    static HTTPS: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    let slot = match scheme {
        SchemePolicy::HttpOrHttps => &HTTP,
        SchemePolicy::HttpsOnly => &HTTPS,
    };
    slot.get_or_init(|| {
        Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(30))
            .user_agent("HertzStudio/0.1 public-resources")
            .dns_resolver(Arc::new(PublicDns))
            .redirect(reqwest::redirect::Policy::custom(
                move |attempt| match redirect_target(
                    attempt.url(),
                    attempt.previous().len(),
                    scheme,
                ) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error),
                },
            ))
            .build()
    })
    .as_ref()
    .cloned()
    .map_err(|_| "failed to create public-network client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_urls_reject_credentials_non_http_and_non_public_literals() {
        for url in [
            "file:///C:/windows/win.ini",
            "ftp://example.com/audio",
            "https://user:secret@example.com/rss",
            "http://localhost/feed",
            "http://localhost./feed",
            "http://a.local/rss",
            "http://printer/rss",
            "http://127.0.0.1/feed",
            "http://127.1/feed",
            "http://2130706433/feed",
            "http://0x7f000001/feed",
            "http://10.1.2.3/rss",
            "http://172.16.1.2/rss",
            "http://192.168.1.1/rss",
            "http://169.254.169.254/meta",
            "http://100.64.1.1/rss",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[64:ff9b::7f00:1]/",
        ] {
            assert!(
                public_url(url, SchemePolicy::HttpOrHttps).is_err(),
                "must reject {url}"
            );
        }
        for scheme in [SchemePolicy::HttpOrHttps, SchemePolicy::HttpsOnly] {
            assert!(public_url("https://feeds.storyfm.cn/storyfm.xml", scheme).is_ok());
            assert!(public_url("https://[2606:4700:4700::1111]/feed", scheme).is_ok());
        }
        assert!(public_url("http://8.8.8.8/feed", SchemePolicy::HttpOrHttps).is_ok());
        assert!(public_url("http://8.8.8.8/feed", SchemePolicy::HttpsOnly).is_err());
    }

    #[test]
    fn dns_answers_reject_mixed_private_addresses_and_special_ip_ranges() {
        for ip in [
            "192.0.2.1",
            "198.18.1.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "2001::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "special address {ip}");
        }
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
        assert!(public_addresses(vec![public, private]).is_err());
        assert!(public_addresses(vec![]).is_err());
        assert_eq!(public_addresses(vec![public]).unwrap(), vec![public]);
    }

    #[test]
    fn redirects_validate_destination_and_have_a_single_hop_budget() {
        for scheme in [SchemePolicy::HttpOrHttps, SchemePolicy::HttpsOnly] {
            assert!(redirect_target(
                &Url::parse("https://example.com/media.mp3").unwrap(),
                5,
                scheme
            )
            .is_ok());
            assert!(redirect_target(
                &Url::parse("https://example.com/media.mp3").unwrap(),
                6,
                scheme
            )
            .is_err());
            for url in [
                "http://127.0.0.1/private",
                "https://127.0.0.1/private",
                "https://[::ffff:127.0.0.1]/private",
                "https://user:secret@example.com/private",
            ] {
                assert!(redirect_target(&Url::parse(url).unwrap(), 1, scheme).is_err());
            }
        }
        let http = Url::parse("http://example.com/media.mp3").unwrap();
        assert!(redirect_target(&http, 1, SchemePolicy::HttpOrHttps).is_ok());
        assert!(redirect_target(&http, 1, SchemePolicy::HttpsOnly).is_err());
    }

    #[tokio::test]
    async fn public_client_rejects_private_dns_at_the_actual_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let result = client(SchemePolicy::HttpOrHttps)
            .unwrap()
            .get(format!("http://localhost:{port}/private"))
            .send()
            .await;
        assert!(
            result.is_err(),
            "private DNS must never establish a connection"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn public_client_stops_private_redirects_before_sending_the_target_request() {
        use axum::routing::get;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let private_hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route(
                "/start",
                get(move || async move {
                    axum::response::Redirect::temporary(&format!("http://{addr}/private"))
                }),
            )
            .route(
                "/private",
                get({
                    let hits = private_hits.clone();
                    move || {
                        hits.fetch_add(1, Ordering::SeqCst);
                        async { "private" }
                    }
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // 仅此本机测试绕过首跳准入，以单独验证重定向策略。
        let result = client(SchemePolicy::HttpOrHttps)
            .unwrap()
            .get(format!("http://{addr}/start"))
            .send()
            .await;
        assert!(result.unwrap_err().is_redirect());
        assert_eq!(private_hits.load(Ordering::SeqCst), 0);
        server.abort();
    }
}
