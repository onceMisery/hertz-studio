// SPDX-License-Identifier: MIT
//! HTTP transport policy for the in-process native window. Credential and
//! ticket ownership stays in the existing handlers; reject before calling them.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

pub fn validate_bind(native: bool, bind: &str) -> anyhow::Result<()> {
    if native && bind != "127.0.0.1" {
        anyhow::bail!(
            "原生主窗口的 HTTP 服务必须绑定 127.0.0.1；请检查 --bind、环境变量和 server.bind 配置"
        );
    }
    Ok(())
}

#[derive(Clone)]
pub struct Policy {
    authority: String,
    origin: String,
    websocket: String,
    port: u16,
}

impl Policy {
    pub fn new(port: u16) -> Self {
        let authority = if port == 80 {
            "127.0.0.1".to_owned()
        } else {
            format!("127.0.0.1:{port}")
        };
        Self {
            origin: format!("http://{authority}"),
            websocket: format!("ws://{authority}"),
            authority,
            port,
        }
    }

    fn authority_ok(&self, value: &str) -> bool {
        value == self.authority || (self.port == 80 && value == "127.0.0.1:80")
    }

    fn check(&self, headers: &HeaderMap, uri: &Uri) -> Result<(), StatusCode> {
        let mut hosts = headers.get_all(header::HOST).iter();
        let host = hosts.next().and_then(|value| value.to_str().ok());
        if hosts.next().is_some() || !host.is_some_and(|value| self.authority_ok(value)) {
            return Err(StatusCode::MISDIRECTED_REQUEST);
        }
        // Absolute-form requests must agree with Host too; do not allow proxy
        // authority, credentials, aliases or a different scheme through routing.
        if uri.scheme_str().is_some_and(|scheme| scheme != "http")
            || uri
                .authority()
                .is_some_and(|authority| !self.authority_ok(authority.as_str()))
        {
            return Err(StatusCode::MISDIRECTED_REQUEST);
        }
        let mut origins = headers.get_all(header::ORIGIN).iter();
        if let Some(value) = origins.next() {
            if origins.next().is_some() || value.to_str().ok() != Some(self.origin.as_str()) {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        // Non-browser clients may omit Origin. This never supplies credentials:
        // the existing bearer/key/session/ticket handlers still decide access.
        Ok(())
    }

    fn csp(&self, nonce: &str) -> HeaderValue {
        // Pixi's local shader pipeline needs function generation and Blob
        // workers. Dynamic theme CSS needs inline style. Neither permission
        // authorizes injected script tags or event attributes.
        HeaderValue::from_str(&format!(
            "default-src 'none'; script-src 'self' 'nonce-{nonce}' 'unsafe-eval'; \
             script-src-attr 'none'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob: http: https:; \
             media-src 'self' data: blob: http: https:; font-src 'self' data: blob:; \
             connect-src 'self' {} blob: data:; worker-src 'self' blob:; \
             object-src 'none'; frame-src 'none'; frame-ancestors 'none'; \
             base-uri 'none'; form-action 'self'",
            self.websocket
        ))
        .expect("CSP only contains fixed directives, a local port and random hex")
    }
}

fn protect_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}

pub async fn guard(State(policy): State<Option<Policy>>, request: Request, next: Next) -> Response {
    let Some(policy) = policy else {
        return next.run(request).await;
    };
    let mut response = match policy.check(request.headers(), request.uri()) {
        Ok(()) => next.run(request).await,
        Err(StatusCode::MISDIRECTED_REQUEST) => (
            StatusCode::MISDIRECTED_REQUEST,
            "native HTTP authority rejected",
        )
            .into_response(),
        Err(_) => (StatusCode::FORBIDDEN, "native HTTP origin rejected").into_response(),
    };
    protect_headers(&mut response);
    response
}

/// Only call for the compiled index, credential form and overlay templates.
/// Never bless scripts from reader/article/user HTML with a generated nonce.
pub fn html_response(policy: Option<&Policy>, status: StatusCode, html: String) -> Response {
    let Some(policy) = policy else {
        return (
            status,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            html,
        )
            .into_response();
    };
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    // These owned templates use exact <script> for inline boot code. External
    // same-origin scripts need no nonce. No request content is parsed here.
    let html = html.replace("<script>", &format!("<script nonce=\"{nonce}\">"));
    let mut response = (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response();
    response
        .headers_mut()
        .insert("content-security-policy", policy.csp(&nonce));
    protect_headers(&mut response);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_bind_refuses_aliases_and_other_interfaces() {
        for value in [
            "0.0.0.0",
            "::1",
            "127.0.0.2",
            "localhost",
            "192.168.1.2",
            "",
        ] {
            assert!(validate_bind(true, value).is_err(), "{value}");
            assert!(validate_bind(false, value).is_ok(), "browser bind {value}");
        }
        assert!(validate_bind(true, "127.0.0.1").is_ok());
    }

    #[test]
    fn authority_and_origin_reject_conflicts_and_duplicates() {
        let policy = Policy::new(41329);
        let uri = Uri::from_static("/ws?ticket=not-consumed-here");
        let mut headers = HeaderMap::new();
        assert_eq!(
            policy.check(&headers, &uri),
            Err(StatusCode::MISDIRECTED_REQUEST)
        );
        for host in [
            "localhost:41329",
            "127.0.0.1:41328",
            "evil.example:41329",
            "user@127.0.0.1:41329",
            "127.0.0.1:41329, evil.example",
        ] {
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            assert_eq!(
                policy.check(&headers, &uri),
                Err(StatusCode::MISDIRECTED_REQUEST),
                "{host}"
            );
        }
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:41329"));
        assert!(policy.check(&headers, &uri).is_ok());
        headers.append(header::HOST, HeaderValue::from_static("127.0.0.1:41329"));
        assert_eq!(
            policy.check(&headers, &uri),
            Err(StatusCode::MISDIRECTED_REQUEST)
        );
        headers.remove(header::HOST);
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:41329"));
        for origin in [
            "null",
            "https://127.0.0.1:41329",
            "http://localhost:41329",
            "http://127.0.0.1:41328",
            "http://127.0.0.1:41329/",
            "http://evil.example",
        ] {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            assert_eq!(
                policy.check(&headers, &uri),
                Err(StatusCode::FORBIDDEN),
                "{origin}"
            );
        }
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:41329"),
        );
        assert!(policy.check(&headers, &uri).is_ok());
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:41329"),
        );
        assert_eq!(policy.check(&headers, &uri), Err(StatusCode::FORBIDDEN));
        headers.remove(header::ORIGIN);
        for target in [
            "http://evil.example/ws",
            "https://127.0.0.1:41329/ws",
            "http://127.0.0.1:41328/ws",
        ] {
            assert_eq!(
                policy.check(&headers, &target.parse().unwrap()),
                Err(StatusCode::MISDIRECTED_REQUEST),
                "{target}"
            );
        }
        assert!(policy
            .check(&headers, &Uri::from_static("http://127.0.0.1:41329/ws"))
            .is_ok());
        let http = Policy::new(80);
        for host in ["127.0.0.1", "127.0.0.1:80"] {
            headers.insert(header::HOST, HeaderValue::from_static(host));
            headers.insert(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1"));
            assert!(http.check(&headers, &uri).is_ok());
        }
    }

    #[tokio::test]
    async fn ingress_rejects_before_body_extraction_and_handler_side_effects() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new()
            .route(
                "/",
                axum::routing::post({
                    let calls = calls.clone();
                    move |_: axum::Json<serde_json::Value>| {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            StatusCode::NO_CONTENT
                        }
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                Some(Policy::new(port)),
                guard,
            ));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/");
        let bad_host = client
            .post(&url)
            .header("host", "evil.example")
            .header("content-type", "application/json")
            .body("not JSON")
            .send()
            .await
            .unwrap();
        assert_eq!(bad_host.status(), StatusCode::MISDIRECTED_REQUEST);
        let bad_origin = client
            .post(&url)
            .header("origin", "null")
            .header("content-type", "application/json")
            .body("not JSON")
            .send()
            .await
            .unwrap();
        assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let ok = client
            .post(&url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn owned_html_uses_fresh_nonce_and_browser_html_keeps_its_contract() {
        let policy = Policy::new(41817);
        let template = "<script>boot()</script><script src=\"/host.js\"></script>";
        let first = html_response(Some(&policy), StatusCode::OK, template.to_owned());
        let second = html_response(Some(&policy), StatusCode::UNAUTHORIZED, template.to_owned());
        let csp = first.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .to_owned();
        assert_ne!(csp, second.headers()["content-security-policy"]);
        let nonce = csp
            .split("'nonce-")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap();
        assert_eq!(nonce.len(), 64);
        let text = String::from_utf8(
            axum::body::to_bytes(first.into_body(), 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(text.contains(&format!("<script nonce=\"{nonce}\">boot()")));
        assert!(text.contains("<script src=\"/host.js\">"));
        assert_eq!(second.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(second.headers()["referrer-policy"], "no-referrer");
        assert_eq!(second.headers()["x-frame-options"], "DENY");
        assert!(csp.contains("connect-src 'self' ws://127.0.0.1:41817"));
        let browser = html_response(None, StatusCode::OK, template.to_owned());
        assert_eq!(browser.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(!browser.headers().contains_key("content-security-policy"));
    }
}
