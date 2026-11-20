// SPDX-License-Identifier: MIT
//! Real HTTP response/stream/cancellation behavior at the native mutation owner.
//! Only the fixture client uses loopback HTTP; production still constructs pinned HTTPS.
use super::*;
use crate::wallpaper::{
    community::{auth::Account, test_support::assert_error},
    library::tempfileish,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

struct Fixture {
    url: reqwest::Url,
    received: oneshot::Receiver<Vec<u8>>,
    reply: oneshot::Sender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
}

async fn fixture() -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!(
        "http://{}/v1/uploads/11111111-1111-4111-8111-111111111111/content",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let (received_tx, received) = oneshot::channel();
    let (reply, reply_rx) = oneshot::channel::<Vec<u8>>();
    let task = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let bytes = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
                .await
                .unwrap()
                .unwrap();
            assert_ne!(bytes, 0, "request ended before its declared body");
            request.extend_from_slice(&chunk[..bytes]);
            assert!(request.len() <= 256 * 1024);
            if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .map(|value| value.trim().parse().unwrap())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    assert_eq!(request.len(), end + 4 + length);
                    break;
                }
            }
        }
        received_tx.send(request).unwrap();
        if let Ok(response) = reply_rx.await {
            // A cancelled client can close its socket before the fixture replies.
            let _ = stream.write_all(&response).await;
        }
    });
    Fixture {
        url,
        received,
        reply,
        task,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

fn session(auth: &Auth) -> RequestSession {
    auth.session_for_test(
        Account {
            source_id: "22222222-2222-4222-8222-222222222222".into(),
            issuer: "https://identity.example".into(),
            subject: "author-a".into(),
            expires_at: super::super::now() + 3600,
        },
        "isolated-author-token",
    )
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
        body.len()
    );
    [head.as_bytes(), body].concat()
}

async fn exchange(raw: Vec<u8>) -> Result<Vec<u8>, JobError> {
    let fixture = fixture().await;
    let auth = Auth::new().unwrap();
    let session = session(&auth);
    fixture.reply.send(raw).unwrap();
    let result = send(
        client().post(fixture.url).body("confirmed-operation"),
        &auth,
        &session,
        &AtomicBool::new(false),
    )
    .await;
    assert!(!fixture.received.await.unwrap().is_empty());
    fixture.task.await.unwrap();
    result
}

#[tokio::test]
async fn accepted_bad_receipts_preserve_unknown_results_instead_of_ordinary_failure() {
    for body in [
        br#"{"id":1,"id":2}"#.as_slice(),
        b"{malformed}".as_slice(),
        br#"{"id":"unfinished""#.as_slice(),
    ] {
        assert_error(
            exchange(response("201 Created", "", body)).await,
            "author_result_unknown",
        );
    }
    let oversized = vec![b' '; 1024 * 1024 + 1];
    assert_error(
        exchange(response("200 OK", "", &oversized)).await,
        "author_result_unknown",
    );
    assert_error(
        exchange(response("200 OK", "Content-Encoding: gzip\r\n", b"{}")).await,
        "author_result_unknown",
    );
}

#[tokio::test]
async fn explicit_rejections_keep_their_cause_and_unknown_status_does_not_replay() {
    for (status, code) in [
        ("401 Unauthorized", "login_required"),
        ("403 Forbidden", "community_denied"),
        ("404 Not Found", "community_not_found"),
        ("409 Conflict", "community_conflict"),
        ("413 Payload Too Large", "community_invalid_input"),
        ("429 Too Many Requests", "community_rate_limit"),
        ("500 Internal Server Error", "author_result_unknown"),
        ("307 Temporary Redirect", "author_result_unknown"),
    ] {
        assert_error(exchange(response(status, "", b"{}")).await, code);
    }
}

#[tokio::test]
async fn fixed_upload_stream_has_exact_bytes_length_and_authentication() {
    let fixture = fixture().await;
    let root = tempfileish::temp_dir("author-upload-stream");
    let bytes: Vec<u8> = (0..128 * 1024).map(|i| (i % 251) as u8).collect();
    let path = root.path().join("fixed.hwpkg");
    std::fs::write(&path, &bytes).unwrap();
    let auth = Auth::new().unwrap();
    let session = session(&auth);
    let request = upload_request(
        &client(),
        fixture.url,
        &session,
        std::fs::File::open(path).unwrap(),
        bytes.len() as u64,
    );
    fixture
        .reply
        .send(response("200 OK", "", br#"{"state":"ready"}"#))
        .unwrap();
    let result = send(request, &auth, &session, &AtomicBool::new(false))
        .await
        .unwrap();
    assert_eq!(
        decode::<serde_json::Value>(&result).unwrap()["state"],
        "ready"
    );
    let received = fixture.received.await.unwrap();
    let end = received.windows(4).position(|v| v == b"\r\n\r\n").unwrap();
    let header = String::from_utf8_lossy(&received[..end]).to_lowercase();
    assert!(header.starts_with("put /v1/uploads/"));
    assert!(header.contains("authorization: bearer isolated-author-token\r\n"));
    assert!(header.contains("content-type: application/octet-stream\r\n"));
    assert!(header.contains(&format!("content-length: {}\r\n", bytes.len())));
    assert!(header.contains("accept-encoding: identity"));
    assert!(!header.contains("transfer-encoding:"));
    assert_eq!(&received[end + 4..], bytes);
    fixture.task.await.unwrap();
}

#[tokio::test]
async fn cancellation_and_account_epoch_change_stop_an_admitted_request_without_replay() {
    for invalidate_account in [false, true] {
        let fixture = fixture().await;
        let auth = std::sync::Arc::new(Auth::new().unwrap());
        let session = session(&auth);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let request = client().post(fixture.url).body("original-operation");
        let pending_auth = std::sync::Arc::clone(&auth);
        let pending_cancel = std::sync::Arc::clone(&cancel);
        let pending =
            tokio::spawn(
                async move { send(request, &pending_auth, &session, &pending_cancel).await },
            );
        fixture.received.await.unwrap();
        if invalidate_account {
            auth.stop();
        } else {
            cancel.store(true, Ordering::Release);
        }
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("native cancellation must release the request promptly")
            .unwrap();
        assert_error(result, "author_result_unknown");
        drop(fixture.reply);
        fixture.task.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_before_dispatch_does_not_connect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let auth = Auth::new().unwrap();
    let session = session(&auth);
    let request = client()
        .post(format!("http://{}/unused", listener.local_addr().unwrap()))
        .body("never-dispatched");
    assert_error(
        send(request, &auth, &session, &AtomicBool::new(true)).await,
        "cancelled",
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}
