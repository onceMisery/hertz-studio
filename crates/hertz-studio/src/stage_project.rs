// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Explicit, bounded complete-file media identity for editable stage projects.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vmusic_core::TrackSource;

use crate::{
    error::{bad_request, not_found, ApiError, ApiResult},
    state::AppState,
};

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
static READERS: std::sync::LazyLock<Arc<Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(Semaphore::new(1)));

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MediaRequest {
    pub track_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentifyRequest {
    pub track_id: String,
    #[serde(default)]
    pub allow_remote_read: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaIdentity {
    kind: &'static str,
    pub(crate) sha256: String,
    pub(crate) byte_length: String,
}

fn error(status: StatusCode, code: &'static str, message: &str) -> ApiError {
    ApiError::new(status, code, message)
}
fn unavailable() -> ApiError {
    error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "project_media_unavailable",
        "无法读取稳定的完整媒体内容",
    )
}
fn deadline() -> ApiError {
    error(
        StatusCode::REQUEST_TIMEOUT,
        "project_media_timeout",
        "媒体指纹读取超时，请稍后重试",
    )
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn check(until: Instant, cancelled: &AtomicBool) -> ApiResult<()> {
    if cancelled.load(Ordering::Relaxed) || Instant::now() >= until {
        return Err(deadline());
    }
    Ok(())
}

/// One complete response, no Range, redirects, retries, proxy, decompression or
/// on-disk copy. URL and credentials originate only from the library/keystore.
fn fingerprint_remote(
    url: &str,
    credential_key: Option<&str>,
    until: Instant,
    cancelled: &AtomicBool,
) -> ApiResult<MediaIdentity> {
    check(until, cancelled)?;
    let url = reqwest::Url::parse(url).map_err(|_| unavailable())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(unavailable());
    }
    let auth = credential_key
        .and_then(|key| crate::remote::read_auth(crate::secrets::backend().as_ref(), key));
    check(until, cancelled)?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(3))
        .timeout(
            until
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1)),
        )
        .build()
        .map_err(|_| unavailable())?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if let Some(auth) = auth {
        request = request.basic_auth(auth.username, Some(auth.password));
    }
    let network_error = |e: reqwest::Error| {
        if e.is_timeout() {
            deadline()
        } else {
            unavailable()
        }
    };
    let mut response = request.send().map_err(network_error)?;
    if response.status() != StatusCode::OK
        || response
            .headers()
            .contains_key(reqwest::header::CONTENT_RANGE)
        || response
            .headers()
            .get_all(reqwest::header::CONTENT_ENCODING)
            .iter()
            .any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(unavailable());
    }
    let expected = response.content_length();
    if expected.is_some_and(|len| len > MAX_BYTES) {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "project_media_size",
            "远程文件超过 2 GiB 指纹读取上限",
        ));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        check(until, cancelled)?;
        let count = response.read(&mut buffer).map_err(|e| {
            if Instant::now() >= until
                || matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                )
                || e.get_ref()
                    .and_then(|e| e.downcast_ref::<reqwest::Error>())
                    .is_some_and(reqwest::Error::is_timeout)
            {
                deadline()
            } else {
                unavailable()
            }
        })?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_BYTES {
            return Err(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "project_media_size",
                "远程文件超过 2 GiB 指纹读取上限",
            ));
        }
        hash.update(&buffer[..count]);
    }
    check(until, cancelled)?;
    if bytes == 0 || expected.is_some_and(|len| len != bytes) {
        return Err(unavailable());
    }
    Ok(MediaIdentity {
        kind: "file-sha256-v1",
        sha256: format!("{:x}", hash.finalize()),
        byte_length: bytes.to_string(),
    })
}

#[cfg(test)]
fn fingerprint(path: &Path, until: Instant) -> ApiResult<MediaIdentity> {
    Ok(fingerprinted_file(path, until, || Ok(()))?.1)
}

/// Reuse the complete content identity for offline analysis, retaining the same
/// opened file instead of reopening an unchecked path after hashing.
pub(crate) fn fingerprinted_file(
    path: &Path,
    until: Instant,
    check: impl Fn() -> ApiResult<()>,
) -> ApiResult<(File, MediaIdentity)> {
    let mut file = File::open(path).map_err(|_| unavailable())?;
    let before = file.metadata().map_err(|_| unavailable())?;
    if !before.is_file() {
        return Err(unavailable());
    }
    if before.len() > MAX_BYTES {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "project_media_size",
            "本地文件超过 2 GiB 指纹读取上限",
        ));
    }
    let modified = before.modified().map_err(|_| unavailable())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        check()?;
        if Instant::now() >= until {
            return Err(deadline());
        }
        let count = file.read(&mut buffer).map_err(|_| unavailable())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_BYTES {
            return Err(unavailable());
        }
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|_| unavailable())?;
    let named = std::fs::metadata(path).map_err(|_| unavailable())?;
    if bytes != before.len()
        || [after, named]
            .iter()
            .any(|m| m.len() != bytes || m.modified().ok() != Some(modified))
    {
        return Err(error(
            StatusCode::CONFLICT,
            "project_media_changed",
            "读取期间媒体文件发生变化，请重新载入后验证",
        ));
    }
    if Instant::now() >= until {
        return Err(deadline());
    }
    let identity = MediaIdentity {
        kind: "local-file-sha256-v1",
        sha256: format!("{:x}", hash.finalize()),
        byte_length: bytes.to_string(),
    };
    file.seek(SeekFrom::Start(0)).map_err(|_| unavailable())?;
    Ok((file, identity))
}

pub(crate) async fn identify(
    state: &Arc<AppState>,
    request: IdentifyRequest,
) -> ApiResult<MediaIdentity> {
    if request.track_id.is_empty() || request.track_id.len() > 256 {
        return Err(bad_request("无效曲库 ID"));
    }
    let permit = READERS.clone().try_acquire_owned().map_err(|_| {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "project_media_busy",
            "已有媒体指纹正在读取，请稍后重试",
        )
    })?;
    let until = Instant::now() + Duration::from_secs(10);
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let work = async move {
        if crate::online::split_virtual_id(&request.track_id).is_some() {
            let generation = state.audio.snapshot().generation;
            let path = state
                .project_online_media(&request.track_id)
                .await
                .ok_or_else(|| {
                    error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "project_media_incomplete",
                        "当前在线曲目的完整缓存尚不可用，请等待下载完成后重试",
                    )
                })?;
            let original_path = path.clone();
            let identity = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let (_, mut identity) =
                    fingerprinted_file(&path, until, || check(until, &cancelled))?;
                identity.kind = "file-sha256-v1";
                Ok::<_, ApiError>(identity)
            })
            .await
            .map_err(|_| unavailable())??;
            // A late hash must not be attached to another playback selection.
            if state.audio.snapshot().generation != generation
                || state.project_online_media(&request.track_id).await.as_ref()
                    != Some(&original_path)
            {
                return Err(error(
                    StatusCode::CONFLICT,
                    "project_media_changed",
                    "当前媒体已改变，请重新确认",
                ));
            }
            return Ok(identity);
        }
        let track = vmusic_store::get_track(&state.db, &request.track_id)
            .await
            .map_err(vmusic_core::CoreError::from)?
            .ok_or_else(|| not_found("未找到曲库曲目"))?;
        if matches!(track.source, TrackSource::Remote) {
            if !request.allow_remote_read {
                return Err(error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "project_media_remote_consent",
                    "请先允许读取远程完整音频，再确认媒体内容",
                ));
            }
            let key = crate::remote::credential_key_for_url(&state.db, &track.path).await;
            return tokio::task::spawn_blocking(move || {
                let _permit = permit;
                fingerprint_remote(&track.path, key.as_deref(), until, &cancelled)
            })
            .await
            .map_err(|_| unavailable())?;
        }
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            Ok(fingerprinted_file(Path::new(&track.path), until, || check(until, &cancelled))?.1)
        })
        .await
        .map_err(|_| unavailable())?
    };
    tokio::time::timeout(Duration::from_secs(12), work)
        .await
        .map_err(|_| deadline())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn accept_bounded(listener: std::net::TcpListener) -> std::net::TcpStream {
        listener.set_nonblocking(true).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((socket, _)) => {
                    // Windows accepted sockets inherit the listener's mode.
                    // Only accept is polled; request reads use socket deadlines.
                    socket.set_nonblocking(false).unwrap();
                    return socket;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("bounded fixture accept: {e}"),
            }
        }
    }
    #[test]
    fn file_identity_is_complete_content_without_path() {
        let dir = std::env::temp_dir().join(format!("hertz-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let first = dir.join("private-name.bin");
        std::fs::write(&first, b"abc").unwrap();
        let id = fingerprint(&first, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(
            id.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(id.byte_length, "3");
        assert!(!serde_json::to_string(&id).unwrap().contains("private"));
        let second = dir.join("renamed.bin");
        std::fs::rename(&first, &second).unwrap();
        assert_eq!(
            id,
            fingerprint(&second, Instant::now() + Duration::from_secs(1)).unwrap()
        );
        std::fs::write(&second, b"abd").unwrap();
        assert_ne!(
            id,
            fingerprint(&second, Instant::now() + Duration::from_secs(1)).unwrap()
        );
        assert_eq!(
            fingerprint(&second, Instant::now()).unwrap_err().code,
            "project_media_timeout"
        );
        assert!(fingerprint(&dir, Instant::now() + Duration::from_secs(1)).is_err());
        File::create(&first)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            fingerprint(&first, Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .code,
            "project_media_size"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn request_rejects_paths_and_extra_fields() {
        assert!(serde_json::from_value::<MediaRequest>(
            serde_json::json!({"track_id":"a","path":"secret"})
        )
        .is_err());
        assert!(
            serde_json::from_value::<MediaRequest>(serde_json::json!({"path":"secret"})).is_err()
        );
        let old: IdentifyRequest =
            serde_json::from_value(serde_json::json!({"track_id":"a"})).unwrap();
        assert!(!old.allow_remote_read);
        for extra in [
            serde_json::json!({"track_id":"a","url":"https://private"}),
            serde_json::json!({"track_id":"a","allow_remote_read":"true"}),
        ] {
            assert!(serde_json::from_value::<IdentifyRequest>(extra).is_err());
        }
    }

    #[test]
    fn remote_identity_hashes_only_one_complete_unencoded_response() {
        use std::io::Write;
        fn probe(reply: &'static [u8]) -> ApiResult<MediaIdentity> {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let mut socket = accept_bounded(listener);
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.starts_with("get /private.wav?secret=hidden http/1.1"));
                assert!(request.contains("accept-encoding: identity\r\n"));
                assert!(!request.contains("\r\nrange:"));
                socket.write_all(reply).unwrap();
            });
            let result = fingerprint_remote(
                &format!("http://{addr}/private.wav?secret=hidden"),
                None,
                Instant::now() + Duration::from_secs(2),
                &AtomicBool::new(false),
            );
            server.join().unwrap();
            result
        }
        for reply in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n".as_slice(),
        ] {
            let id = probe(reply).unwrap();
            assert_eq!(id.kind, "file-sha256-v1");
            assert_eq!(id.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
            assert_eq!(id.byte_length, "3");
        }
        for reply in [
            b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Range: bytes 0-2/5\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabc".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 2147483649\r\nConnection: close\r\n\r\n".as_slice(),
        ] {
            let e = probe(reply).unwrap_err();
            assert!(!e.message.contains("secret") && !e.message.contains("private.wav"));
        }
        assert_eq!(
            fingerprint_remote(
                "http://127.0.0.1:1/",
                None,
                Instant::now(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "project_media_timeout"
        );
        assert_eq!(
            fingerprint_remote(
                "http://127.0.0.1:1/",
                None,
                Instant::now() + Duration::from_secs(1),
                &AtomicBool::new(true)
            )
            .unwrap_err()
            .code,
            "project_media_timeout"
        );
    }

    #[test]
    fn remote_body_stall_obeys_the_total_deadline() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut socket = accept_bounded(listener);
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na");
            std::thread::sleep(Duration::from_millis(800));
            let _ = socket.write_all(b"bc");
        });
        let result = fingerprint_remote(
            &format!("http://{addr}/file"),
            None,
            Instant::now() + Duration::from_millis(500),
            &AtomicBool::new(false),
        );
        assert_eq!(result.unwrap_err().code, "project_media_timeout");
        server.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn media_sources_share_identity_budget_and_rpc_without_implicit_network() {
        use serde_json::json;
        use std::sync::atomic::AtomicUsize;
        let dir = std::env::temp_dir().join(format!("hertz-project-api-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(state);
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (started, finish) = (entered.clone(), release.clone());
        let app = axum::Router::new()
            .route(
                "/slow",
                axum::routing::get(move || {
                    let (started, finish) = (started.clone(), finish.clone());
                    async move {
                        started.notify_one();
                        let _ =
                            tokio::time::timeout(Duration::from_secs(3), finish.notified()).await;
                        b"abc".as_slice()
                    }
                }),
            )
            .route(
                "/file",
                axum::routing::get(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    async { b"abc".as_slice() }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let local = dir.join("private.wav");
        std::fs::write(&local, b"abc").unwrap();
        let mut track = vmusic_core::Track {
            id: "local".into(),
            path: local.to_string_lossy().into_owned(),
            source: TrackSource::Local,
            title: "private".into(),
            artist: None,
            album: None,
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        };
        vmusic_store::upsert_track(&state.db, &track).await.unwrap();
        let local_id = identify(
            &state,
            IdentifyRequest {
                track_id: "local".into(),
                allow_remote_read: false,
            },
        )
        .await
        .unwrap();
        track.id = "remote".into();
        track.source = TrackSource::Remote;
        track.path = format!("http://{addr}/file");
        vmusic_store::upsert_track(&state.db, &track).await.unwrap();
        assert_eq!(
            identify(
                &state,
                IdentifyRequest {
                    track_id: "remote".into(),
                    allow_remote_read: false
                }
            )
            .await
            .unwrap_err()
            .code,
            "project_media_remote_consent"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let remote_id = identify(
            &state,
            IdentifyRequest {
                track_id: "remote".into(),
                allow_remote_read: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(remote_id.sha256, local_id.sha256);
        assert_eq!(remote_id.byte_length, local_id.byte_length);
        let rpc = crate::rpc::Rpc::new(state.clone());
        let reply = rpc
            .call(crate::rpc::Call {
                op: crate::rpc::Op::Post,
                path: "v1/stage/project-media",
                query: json!({}),
                body: json!({"track_id":"remote", "allow_remote_read":true}),
                raw: None,
                client_operation_id: None,
            })
            .await
            .unwrap();
        assert_eq!(reply.body, serde_json::to_value(remote_id).unwrap());
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "one complete request per explicit operation"
        );
        assert_eq!(
            identify(
                &state,
                IdentifyRequest {
                    track_id: "online:ccmixter:uncached".into(),
                    allow_remote_read: true
                }
            )
            .await
            .unwrap_err()
            .code,
            "project_media_incomplete"
        );
        let occupied = READERS.clone().acquire_owned().await.unwrap();
        assert_eq!(
            identify(
                &state,
                IdentifyRequest {
                    track_id: "remote".into(),
                    allow_remote_read: true
                }
            )
            .await
            .unwrap_err()
            .code,
            "project_media_busy"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        drop(occupied);
        track.path = format!("http://{addr}/slow");
        sqlx::query("UPDATE tracks SET path = ?1 WHERE id = ?2")
            .bind(&track.path)
            .bind(&track.id)
            .execute(&state.db)
            .await
            .unwrap();
        let observer = tokio::spawn({
            let state = state.clone();
            async move {
                identify(
                    &state,
                    IdentifyRequest {
                        track_id: "remote".into(),
                        allow_remote_read: true,
                    },
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        observer.abort();
        assert!(observer.await.unwrap_err().is_cancelled());
        assert_eq!(
            READERS.available_permits(),
            0,
            "observer cancellation does not release live remote I/O"
        );
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            while READERS.available_permits() == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            state.audio.snapshot().track_id.is_none(),
            "hashing never loads media"
        );
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}
