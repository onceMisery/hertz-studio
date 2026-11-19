// SPDX-License-Identifier: MIT
#[cfg(test)]
#[path = "auth_callback_tests.rs"]
mod tests;
use super::super::error;
use crate::wallpaper::jobs::JobError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

pub(super) struct Pkce {
    listener: tokio::net::TcpListener,
    pub redirect: String,
    pub state: String,
    pub verifier: Zeroizing<String>,
    pub challenge: String,
    created: Instant,
    consumed: AtomicBool,
}

impl Pkce {
    pub(super) async fn new() -> Result<Self, JobError> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| error("callback_unavailable", "无法建立本机登录回调"))?;
        let port = listener
            .local_addr()
            .map_err(|_| error("callback_unavailable", "无法读取登录回调端口"))?
            .port();
        let mut state = [0u8; 32];
        let mut verifier = [0u8; 32];
        getrandom::fill(&mut state).map_err(|_| error("login_entropy", "登录随机数不可用"))?;
        getrandom::fill(&mut verifier).map_err(|_| error("login_entropy", "PKCE 随机数不可用"))?;
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(verifier));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            listener,
            redirect: format!("http://127.0.0.1:{port}/oauth/callback"),
            state: URL_SAFE_NO_PAD.encode(state),
            verifier,
            challenge,
            created: Instant::now(),
            consumed: AtomicBool::new(false),
        })
    }

    pub(super) async fn wait(
        &self,
        cancel: &AtomicBool,
        issuer: &str,
    ) -> Result<Zeroizing<String>, JobError> {
        // Claim the whole flow before awaiting so concurrent or repeated waits
        // cannot consume a second code, including after cancellation or denial.
        if self.consumed.swap(true, Ordering::AcqRel) {
            return Err(error("callback_consumed", "此登录回调已使用，请重新登录"));
        }
        let deadline = self.created + Duration::from_secs(300);
        let expected_host = self
            .redirect
            .trim_start_matches("http://")
            .split('/')
            .next()
            .expect("callback host");
        let mut attempts = 0;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(error("cancelled", "社区登录已取消"));
            }
            if Instant::now() >= deadline {
                return Err(error("login_expired", "社区登录超过五分钟，请重新登录"));
            }
            let accepted = tokio::select! {value=self.listener.accept()=>Some(value),_=tokio::time::sleep(Duration::from_millis(50))=>None};
            let Some(accepted) = accepted else {
                continue;
            };
            let (mut stream, peer) =
                accepted.map_err(|_| error("callback_unavailable", "登录回调不可用"))?;
            if !peer.ip().is_loopback() {
                continue;
            }
            attempts += 1;
            if attempts > 32 {
                return Err(error("callback_limit", "登录回调请求过多"));
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(4096));
            let mut chunk = Zeroizing::new([0u8; 512]);
            let read_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Err(error("cancelled", "社区登录已取消或到期"));
                }
                let count = tokio::time::timeout_at(
                    tokio::time::Instant::from_std(read_deadline),
                    stream.read(&mut *chunk),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(0);
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > 4096 || bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                    break;
                }
            }
            let parsed = async {
                if bytes.len() > 4096 || !bytes.windows(4).any(|p| p == b"\r\n\r\n") {
                    return Err(error("callback_invalid", "登录回调过大或头部不完整"));
                }
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| error("callback_invalid", "登录回调编码无效"))?;
                let mut lines = text.split("\r\n");
                let line = lines.next().unwrap_or_default();
                let fields: Vec<_> = line.split(' ').collect();
                if fields.len() != 3
                    || fields[0] != "GET"
                    || fields[2] != "HTTP/1.1"
                    || fields[1].split('?').next() != Some("/oauth/callback")
                {
                    return Err(error("callback_invalid", "登录回调请求或确切路径无效"));
                }
                let hosts: Vec<_> = lines
                    .filter_map(|l| l.split_once(':'))
                    .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
                    .map(|(_, v)| v.trim())
                    .collect();
                if hosts.as_slice() != [expected_host] {
                    return Err(error("callback_invalid", "登录回调 Host 不匹配"));
                }
                let url = reqwest::Url::parse(&format!("http://{expected_host}{}", fields[1]))
                    .map_err(|_| error("callback_invalid", "登录回调地址无效"))?;
                if url.path() != "/oauth/callback"
                    || url.fragment().is_some()
                    || url.origin().ascii_serialization() != format!("http://{expected_host}")
                {
                    return Err(error("callback_invalid", "登录回调路径不匹配"));
                }
                let mut query = std::collections::BTreeMap::new();
                for (key, value) in url.query_pairs() {
                    if !matches!(
                        key.as_ref(),
                        "code" | "state" | "iss" | "session_state" | "error" | "error_description"
                    ) || query.insert(key.into_owned(), value.into_owned()).is_some()
                    {
                        return Err(error("callback_invalid", "登录回调字段重复或不受支持"));
                    }
                }
                if query.get("state") != Some(&self.state)
                    || query.get("iss").is_some_and(|v| v != issuer)
                {
                    return Err(error("callback_invalid", "登录 state 或 issuer 不匹配"));
                }
                if query.contains_key("error") {
                    return Err(error("login_declined", "登录提供方未授予此登录"));
                }
                let code = query
                    .remove("code")
                    .ok_or_else(|| error("callback_invalid", "登录回调缺少 code"))?;
                if code.is_empty() || code.len() > 2048 {
                    return Err(error("callback_invalid", "登录 code 无效"));
                }
                Ok(Zeroizing::new(code))
            }
            .await;
            let (status, body) = if parsed.is_ok() {
                (
                    "200 OK",
                    "Login response received. You may return to Hertz.",
                )
            } else {
                ("400 Bad Request", "This login response was not accepted.")
            };
            let reply=format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
            let _ =
                tokio::time::timeout(Duration::from_secs(1), stream.write_all(reply.as_bytes()))
                    .await;
            match parsed {
                Ok(code) => return Ok(code),
                Err(e) if e.code == "login_declined" => return Err(e),
                Err(_) => continue,
            }
        }
    }
}
