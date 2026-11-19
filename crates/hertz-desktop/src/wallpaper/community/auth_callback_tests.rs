// SPDX-License-Identifier: MIT
use super::*;

const ISSUER: &str = "https://community.example/oidc";

fn request(pkce: &Pkce, state: &str, issuer: &str) -> String {
    let mut url = reqwest::Url::parse(&pkce.redirect).unwrap();
    url.query_pairs_mut()
        .append_pair("code", "private-fixture-code")
        .append_pair("state", state)
        .append_pair("iss", issuer);
    format!(
        "GET {}?{} HTTP/1.1\r\nHost: {}:{}\r\n\r\n",
        url.path(),
        url.query().unwrap(),
        url.host_str().unwrap(),
        url.port().unwrap()
    )
}

async fn send(pkce: &Pkce, request: String) -> String {
    let mut stream = tokio::net::TcpStream::connect(pkce.listener.local_addr().unwrap())
        .await
        .unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut reply = vec![];
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut reply))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8(reply).unwrap()
}

#[tokio::test]
async fn callback_accepts_only_exact_path_host_state_issuer_and_unique_known_fields() {
    let pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(false);
    let valid = request(&pkce, &pkce.state, ISSUER);
    let invalid = vec![
        request(&pkce, "wrong-state", ISSUER),
        request(&pkce, &pkce.state, "https://other.example/oidc"),
        valid.replacen("GET ", "POST ", 1),
        valid.replacen("/oauth/callback?", "/other?", 1),
        valid.replacen("Host: ", "Host: attacker.invalid\r\nX-Original-Host: ", 1),
        valid.replacen(" HTTP/1.1", "&state=duplicate HTTP/1.1", 1),
        valid.replacen(" HTTP/1.1", "&unknown=field HTTP/1.1", 1),
    ];
    let (code, ()) = tokio::join!(pkce.wait(&cancel, ISSUER), async {
        for request in invalid {
            let reply = send(&pkce, request).await;
            assert!(reply.starts_with("HTTP/1.1 400"));
            assert!(!reply.contains("private-fixture-code"));
        }
        let reply = send(&pkce, valid).await;
        assert!(reply.starts_with("HTTP/1.1 200"));
        assert!(reply.contains("Cache-Control: no-store"));
        assert!(!reply.contains("private-fixture-code"));
    });
    assert_eq!(code.unwrap().as_str(), "private-fixture-code");
}

#[tokio::test]
async fn a_callback_flow_cannot_be_consumed_twice() {
    let pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(false);
    let (code, _) = tokio::join!(
        pkce.wait(&cancel, ISSUER),
        send(&pkce, request(&pkce, &pkce.state, ISSUER))
    );
    assert!(code.is_ok());
    let repeated =
        tokio::time::timeout(Duration::from_millis(200), pkce.wait(&cancel, ISSUER)).await;
    match repeated {
        Ok(Err(error)) => assert_eq!(error.code, "callback_consumed"),
        _ => panic!("completed PKCE callback must reject a second wait immediately"),
    }
}

#[tokio::test]
async fn concurrent_waits_cannot_share_a_callback_flow() {
    let pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(false);
    let (first, ()) = tokio::join!(pkce.wait(&cancel, ISSUER), async {
        let repeated = tokio::time::timeout(Duration::from_millis(200), pkce.wait(&cancel, ISSUER))
            .await
            .expect("a concurrent wait must fail without accepting another connection");
        assert_eq!(repeated.unwrap_err().code, "callback_consumed");
        assert!(send(&pkce, request(&pkce, &pkce.state, ISSUER))
            .await
            .starts_with("HTTP/1.1 200"));
    });
    assert_eq!(first.unwrap().as_str(), "private-fixture-code");
    assert!(!pkce.verifier.is_empty());
    assert!(pkce.redirect.starts_with("http://127.0.0.1:"));
}

#[tokio::test]
async fn callback_cancellation_and_five_minute_expiry_return_without_accepting_a_code() {
    let mut pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(true);
    assert_eq!(
        pkce.wait(&cancel, ISSUER).await.unwrap_err().code,
        "cancelled"
    );
    assert_eq!(
        pkce.wait(&cancel, ISSUER).await.unwrap_err().code,
        "callback_consumed"
    );
    pkce = Pkce::new().await.unwrap();
    pkce.created = Instant::now() - Duration::from_secs(301);
    cancel.store(false, Ordering::Release);
    assert_eq!(
        pkce.wait(&cancel, ISSUER).await.unwrap_err().code,
        "login_expired"
    );
}

#[tokio::test]
async fn provider_denial_is_terminal_only_for_the_matching_state() {
    let pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(false);
    let valid = request(&pkce, &pkce.state, ISSUER).replacen(
        "code=private-fixture-code",
        "error=access_denied",
        1,
    );
    let invalid = request(&pkce, "wrong-state", ISSUER).replacen(
        "code=private-fixture-code",
        "error=access_denied",
        1,
    );
    let (result, ()) = tokio::join!(pkce.wait(&cancel, ISSUER), async {
        assert!(send(&pkce, invalid).await.starts_with("HTTP/1.1 400"));
        assert!(send(&pkce, valid).await.starts_with("HTTP/1.1 400"));
    });
    assert_eq!(result.unwrap_err().code, "login_declined");
    assert_eq!(
        pkce.wait(&cancel, ISSUER).await.unwrap_err().code,
        "callback_consumed"
    );
}

#[tokio::test]
async fn callback_request_budget_is_bounded() {
    let pkce = Pkce::new().await.unwrap();
    let cancel = AtomicBool::new(false);
    let (result, ()) = tokio::join!(pkce.wait(&cancel, ISSUER), async {
        for _ in 0..32 {
            let reply = send(&pkce, request(&pkce, "wrong-state", ISSUER)).await;
            assert!(reply.starts_with("HTTP/1.1 400"));
        }
        let _last = tokio::net::TcpStream::connect(pkce.listener.local_addr().unwrap())
            .await
            .unwrap();
    });
    assert_eq!(result.unwrap_err().code, "callback_limit");
}
