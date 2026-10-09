// SPDX-License-Identifier: MIT

use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Response, StatusCode, Uri};
use futures::StreamExt;
use serde_json::json;

// Independent fixture encoder for the public SDK signature=1 JSON envelope.
// This is not an audio codec or a credential.
fn envelope_bytes(json: &[u8]) -> Vec<u8> {
    let seed = b"Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP";
    let offset = 173u8;
    let mut encoded = vec![0xab, 0xcd, 0x01, offset];
    encoded.extend(json.iter().enumerate().map(|(index, byte)| {
        byte.wrapping_sub(offset)
            .wrapping_add(seed[index % seed.len()])
    }));
    encoded
}

fn envelope(value: Value) -> Vec<u8> {
    envelope_bytes(&serde_json::to_vec(&value).unwrap())
}

struct Reply {
    status: StatusCode,
    chunks: Vec<Vec<u8>>,
    finish: bool,
}

impl Reply {
    fn bytes(bytes: Vec<u8>) -> Self {
        Self {
            status: StatusCode::OK,
            chunks: vec![bytes],
            finish: true,
        }
    }

    fn json(value: Value) -> Self {
        Self::bytes(serde_json::to_vec(&value).unwrap())
    }
}

#[derive(Debug)]
struct Request {
    path: String,
    query: BTreeMap<String, String>,
    headers: HeaderMap,
}

struct Upstream {
    base: reqwest::Url,
    requests: Arc<Mutex<Vec<Request>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Upstream {
    fn api(&self, pack: Option<&super::super::cred::CredPack>) -> MiguApi {
        let mut api = MiguApi::new(pack).unwrap();
        api.base = self.base.clone();
        api.http = reqwest::Client::builder().no_proxy().build().unwrap();
        api
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn upstream(replies: Vec<Reply>) -> Upstream {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let trace = requests.clone();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    let app = axum::Router::new().fallback(move |uri: Uri, headers: HeaderMap| {
        trace.lock().unwrap().push(Request {
            path: uri.path().to_string(),
            query: serde_urlencoded::from_str(uri.query().unwrap_or_default()).unwrap(),
            headers,
        });
        let reply = replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Reply {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                chunks: vec![],
                finish: true,
            });
        async move {
            let chunks =
                futures::stream::iter(reply.chunks.into_iter().map(Ok::<_, std::io::Error>));
            let body = if reply.finish {
                Body::from_stream(chunks)
            } else {
                Body::from_stream(chunks.chain(futures::stream::pending()))
            };
            Response::builder().status(reply.status).body(body).unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Upstream {
        base,
        requests,
        task,
    }
}

fn metadata() -> Value {
    json!({"code": "000000", "data": {
        "musicListId": "135423084", "title": "华语精选", "summary": "歌单简介",
        "ownerName": "Didi", "musicNum": 113,
        "imgItem": {"img": "/cover/playlist.webp"}, "opNumItem": {"playNum": 21531751}
    }})
}

fn playlist_song(index: usize) -> Value {
    json!({
        "copyrightId": format!("cid-{index}"), "contentId": format!("content-{index}"),
        "songId": index + 1000, "songName": format!("曲目 {index}"),
        "singerList": [{"name": "歌手甲"}, {"name": "歌手乙"}],
        "album": "专辑", "duration": 248,
        "img1": "/cover/small.webp", "img2": "/cover/medium.webp", "img3": "/cover/large.webp",
        "showTags": ["i24"]
    })
}

fn playlist_page(start: usize, end: usize) -> Value {
    json!({"code": "000000", "data": {
        "totalCount": if start == end { 0 } else { 113 },
        "songList": (start..end).map(playlist_song).collect::<Vec<_>>()
    }})
}

fn public_stream() -> Value {
    json!({"code": "000000", "data": {
        "audioFormatType": "PQ", "url": "https://media.example.test/public.mp3?signature=fixture",
        "freeListenType": "0"
    }})
}

#[test]
fn pacmtoken_shape_does_not_accept_other_cookie_or_profile_fields() {
    let mut pack = super::super::cred::CredPack {
        cookie: "analytics=present; userId=123".into(),
        token: "legacy-token".into(),
        userid: "123".into(),
        ..Default::default()
    };
    assert!(!signed_in(&pack));
    for cookie in [
        "pacmtoken=",
        "pacmtoken=  ",
        "pacmtoken=null",
        "pacmtoken=undefined",
        "pacmtoken=line\nbreak",
    ] {
        pack.cookie = cookie.into();
        assert!(
            !signed_in(&pack),
            "invalid token shape must not imply a session"
        );
    }
    pack.cookie = "analytics=present; pacmtoken=fixture-token".into();
    assert!(signed_in(&pack));
}

#[test]
fn account_maps_only_verified_profile_and_keeps_membership_unknown() {
    let account = parse_account(&json!({"code": "000000", "data": {
        "userId": "123", "nickName": "咪咕听众", "smallIcon": "http://img.example.test/avatar.webp",
        "vipLevel": 99
    }}))
    .unwrap();
    assert_eq!(account.source, "migu");
    assert_eq!(account.nickname, "咪咕听众");
    assert_eq!(
        account.avatar.as_deref(),
        Some("https://img.example.test/avatar.webp")
    );
    assert_eq!(account.membership, super::super::ProfileMembership::Unknown);
    assert_eq!(account.vip_level, 0);
    assert!(account.vip_label.is_empty());
}

#[test]
fn invalid_or_missing_account_never_becomes_a_logged_in_profile() {
    let expired = parse_account(&json!({"code": "290001", "info": "请先登录"})).unwrap_err();
    assert_eq!(expired.code, "auth_required");
    for payload in [
        json!({"code": "000000"}),
        json!({"code": "000000", "data": {"nickName": "anonymous"}}),
        json!({"code": "000000", "data": {"userId": 0}}),
        json!({"code": "000000", "data": {"userId": "  "}}),
        json!({"code": 0, "data": {"userId": 123}}),
    ] {
        assert!(parse_account(&payload).is_err());
    }
}

#[tokio::test]
async fn account_http_sends_only_the_pacmtoken_header() {
    let fixture = upstream(vec![Reply::json(json!({"code": "000000", "data": {
        "userId": "123", "nickName": "请求验证", "smallIcon": "https://img.example.test/a.jpg"
    }}))])
    .await;
    let pack = super::super::cred::CredPack {
        cookie: "analytics=do-not-forward; pacmtoken=fixture-token".into(),
        ..Default::default()
    };
    let account = fixture.api(Some(&pack)).account().await.unwrap();
    assert_eq!(account.nickname, "请求验证");
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/user/h5/user-info/v1.0");
    assert_eq!(requests[0].headers["pacmtoken"], "fixture-token");
    assert!(!requests[0].headers.contains_key(reqwest::header::COOKIE));
    assert_eq!(
        requests[0].headers[reqwest::header::REFERER],
        "https://music.migu.cn/v5/"
    );
}

#[tokio::test]
async fn account_http_errors_are_not_misreported_as_expired_login() {
    let fixture = upstream(vec![Reply {
        status: StatusCode::SERVICE_UNAVAILABLE,
        chunks: vec![b"unavailable".to_vec()],
        finish: true,
    }])
    .await;
    let error = fixture.api(None).account().await.unwrap_err();
    assert_eq!(error.code, "upstream_rejected");
    assert!(error.message.contains("503"));
}

#[test]
fn signature_one_envelope_preserves_utf8_and_validates_its_header() {
    let payload = json!({"code": "000000", "info": "操作成功"});
    assert_eq!(
        decode_envelope(&envelope(payload.clone())).unwrap(),
        payload
    );
    for invalid in [
        vec![],
        vec![0xab],
        vec![0xab, 0xcd, 1],
        vec![0xab, 0xcd, 1, 0],
        vec![0xab, 0xcd, 2, 0, 1],
        b"{\"code\":\"000000\"}".to_vec(),
        envelope_bytes(b"not json"),
        envelope_bytes(&[0xff]),
    ] {
        assert_eq!(
            decode_envelope(&invalid).unwrap_err().code,
            "upstream_rejected"
        );
    }
    let mut truncated = envelope(json!({"code": "000000"}));
    truncated.pop();
    assert!(decode_envelope(&truncated).is_err());
}

#[test]
fn signature_one_envelope_has_an_inclusive_two_mib_limit() {
    let mut json = br#"{"code":"000000"}"#.to_vec();
    json.resize(2 * 1024 * 1024 - 4, b' ');
    let encoded = envelope_bytes(&json);
    assert_eq!(encoded.len(), 2 * 1024 * 1024);
    assert_eq!(decode_envelope(&encoded).unwrap()["code"], "000000");
    json.push(b' ');
    assert!(decode_envelope(&envelope_bytes(&json)).is_err());
}

#[tokio::test]
async fn response_reader_accepts_the_exact_limit_without_content_length() {
    let bytes = vec![b'x'; 2 * 1024 * 1024];
    let fixture = upstream(vec![Reply::bytes(bytes.clone())]).await;
    let response = fixture
        .api(None)
        .http
        .get(fixture.base.clone())
        .send()
        .await
        .unwrap();
    assert!(response.content_length().is_none());
    assert_eq!(read_response(response).await.unwrap(), bytes);
}

#[tokio::test]
async fn response_reader_stops_an_over_limit_stream_before_eof() {
    let fixture = upstream(vec![Reply {
        status: StatusCode::OK,
        chunks: vec![vec![b'x'; 2 * 1024 * 1024], vec![b'x']],
        finish: false,
    }])
    .await;
    let response = fixture
        .api(None)
        .http
        .get(fixture.base.clone())
        .send()
        .await
        .unwrap();
    assert!(response.content_length().is_none());
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), read_response(response))
        .await
        .expect("must stop at the limit without waiting for EOF");
    assert_eq!(result.unwrap_err().code, "upstream_rejected");
}

#[test]
fn playlist_track_uses_playlist_fields_and_relative_images() {
    let track = map_playlist_track(&playlist_song(7)).unwrap();
    assert_eq!(track.id, "cid-7");
    assert_eq!(track.title, "曲目 7");
    assert_eq!(track.artist, "歌手甲、歌手乙");
    assert_eq!(track.album, "专辑");
    assert_eq!(track.duration_ms, 248_000);
    assert_eq!(
        track.cover.as_deref(),
        Some("https://d.musicapp.migu.cn/cover/large.webp")
    );
    assert_eq!(track.track_ref["contentId"], "content-7");
    assert_eq!(track.track_ref["copyrightId"], "cid-7");
    assert_eq!(track.track_ref["songId"], "1007");
    assert!(track.playable);
    assert!(!track.vip_only);
    let mut item = playlist_song(8);
    item["showTags"] = json!(["vip", "i24"]);
    let member_track = map_playlist_track(&item).unwrap();
    assert!(member_track.vip_only);
    assert!(member_track.playable);
    item["copyrightId"] = json!("");
    assert!(map_playlist_track(&item).is_none());
}

#[tokio::test]
async fn playlist_detail_crosses_page_boundaries_for_an_unaligned_offset() {
    let fixture = upstream(vec![
        Reply::json(metadata()),
        Reply::json(playlist_page(0, 50)),
        Reply::json(playlist_page(50, 100)),
        Reply::json(playlist_page(100, 113)),
    ])
    .await;
    let detail = fixture
        .api(None)
        .playlist_detail("135423084", 49, 53)
        .await
        .unwrap();
    assert_eq!(detail.total, 113);
    assert_eq!(detail.playlist.id, "135423084");
    assert_eq!(detail.playlist.name, "华语精选");
    assert_eq!(detail.playlist.creator, "Didi");
    assert_eq!(detail.playlist.description.as_deref(), Some("歌单简介"));
    assert_eq!(detail.playlist.play_count, Some(21531751));
    assert_eq!(
        detail.playlist.cover.as_deref(),
        Some("https://d.musicapp.migu.cn/cover/playlist.webp")
    );
    assert_eq!(
        detail
            .tracks
            .iter()
            .map(|track| track.id.clone())
            .collect::<Vec<_>>(),
        (49..102)
            .map(|index| format!("cid-{index}"))
            .collect::<Vec<_>>()
    );
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].path, "/resource/playlist/v2.0");
    for (index, request) in requests[1..].iter().enumerate() {
        assert_eq!(request.path, "/MIGUM3.0/resource/playlist/song/v2.0");
        assert_eq!(request.query["playlistId"], "135423084");
        assert_eq!(request.query["pageNo"], (index + 1).to_string());
        assert_eq!(request.query["pageSize"], "50");
    }
}

#[tokio::test]
async fn empty_playlist_tail_does_not_reset_the_metadata_total() {
    let fixture = upstream(vec![
        Reply::json(metadata()),
        Reply::json(playlist_page(100, 100)),
    ])
    .await;
    let detail = fixture
        .api(None)
        .playlist_detail("135423084", 100, 50)
        .await
        .unwrap();
    assert!(detail.tracks.is_empty());
    assert_eq!(detail.total, 113);
    assert_eq!(detail.playlist.track_count, 113);
    assert_eq!(fixture.requests.lock().unwrap()[1].query["pageNo"], "3");

    let beyond_end = upstream(vec![Reply::json(metadata())]).await;
    let detail = beyond_end
        .api(None)
        .playlist_detail("135423084", usize::MAX, 50)
        .await
        .unwrap();
    assert_eq!(detail.total, 113);
    assert!(detail.tracks.is_empty());
    assert_eq!(beyond_end.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn playlist_metadata_missing_data_is_an_error_even_with_success_code() {
    let fixture = upstream(vec![Reply::json(
        json!({"code": "000000", "info": "success"}),
    )])
    .await;
    let error = fixture
        .api(None)
        .playlist_detail("0", 0, 50)
        .await
        .unwrap_err();
    assert_eq!(error.code, "upstream_rejected");
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_second_playlist_page_does_not_claim_partial_success() {
    let fixture = upstream(vec![
        Reply::json(metadata()),
        Reply::json(playlist_page(0, 50)),
        Reply::json(json!({"code": "299999", "info": "failed"})),
    ])
    .await;
    let error = fixture
        .api(None)
        .playlist_detail("135423084", 49, 2)
        .await
        .unwrap_err();
    assert_eq!(error.code, "upstream_rejected");
}

#[test]
fn stream_parser_requires_permission_before_using_any_returned_url() {
    let stream = parse_stream(&public_stream(), "60058621415").unwrap();
    assert_eq!(stream.source, "migu");
    assert_eq!(stream.id, "60058621415");
    assert_eq!(stream.bitrate, None);
    assert_eq!(stream.expires_in_secs, None);
    assert!(stream.fallbacks.is_empty());
    let mut denied = public_stream();
    denied["data"]["cannotCode"] = json!("440013");
    denied["data"]["auditionsLength"] = json!(60);
    assert_eq!(
        parse_stream(&denied, "vip-track").unwrap_err().code,
        "vip_required"
    );
    denied["data"]["cannotCode"] = json!("290001");
    assert_eq!(
        parse_stream(&denied, "track").unwrap_err().code,
        "auth_required"
    );
    denied["data"]["cannotCode"] = json!("unknown");
    assert_eq!(
        parse_stream(&denied, "track").unwrap_err().code,
        "upstream_rejected"
    );
}

#[test]
fn stream_parser_rejects_missing_or_non_http_media_urls() {
    for url in [
        "",
        "   ",
        "/relative.mp3",
        "file:///tmp/audio.mp3",
        "ftp://media.example.test/a.mp3",
        "javascript:alert(1)",
        "http://",
    ] {
        let mut body = public_stream();
        body["data"]["url"] = json!(url);
        assert_eq!(
            parse_stream(&body, "track").unwrap_err().code,
            "upstream_rejected"
        );
    }
    let mut body = public_stream();
    body["data"]["url"] = Value::Null;
    assert_eq!(
        parse_stream(&body, "track").unwrap_err().code,
        "upstream_rejected"
    );
    body["code"] = json!("299999");
    body["data"]["url"] = json!("https://media.example.test/a.mp3");
    assert_eq!(
        parse_stream(&body, "track").unwrap_err().code,
        "upstream_rejected"
    );
}

#[tokio::test]
async fn stream_without_ref_resolves_content_id_and_requests_public_standard_audio() {
    let fixture = upstream(vec![
        Reply::json(json!({"code": "000000", "resource": [{
            "copyrightId": "60058621415", "contentId": "600902000004468110"
        }]})),
        Reply::bytes(envelope(public_stream())),
    ])
    .await;
    let stream = fixture.api(None).stream("60058621415", None).await.unwrap();
    assert_eq!(
        stream.url,
        "https://media.example.test/public.mp3?signature=fixture"
    );
    assert_eq!(stream.bitrate, None);
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/v1.0/content/resourceinfo.do");
    assert_eq!(requests[0].query["copyrightId"], "60058621415");
    let listen = &requests[1];
    assert_eq!(listen.path, "/strategy/pc/listen/v2.0");
    assert_eq!(listen.query["copyrightId"], "60058621415");
    assert_eq!(listen.query["contentId"], "600902000004468110");
    assert_eq!(listen.query["resourceType"], "2");
    assert_eq!(listen.query["netType"], "01");
    assert_eq!(listen.query["toneFlag"], "PQ");
    assert_eq!(listen.query["scene"], "");
    assert_eq!(listen.headers["signature"], "1");
    assert_eq!(listen.headers["birth"], "h5page");
    assert_eq!(
        listen.headers[reqwest::header::CONTENT_TYPE],
        "application/json;charset=UTF-8"
    );
    assert_eq!(
        listen.headers[reqwest::header::REFERER],
        "https://music.migu.cn/v5/"
    );
    assert!(!listen.headers.contains_key("pacmtoken"));
}

#[tokio::test]
async fn stream_with_a_matching_ref_uses_the_token_and_still_honors_denial() {
    let mut denied = public_stream();
    denied["data"]["cannotCode"] = json!("440013");
    let fixture = upstream(vec![Reply::bytes(envelope(denied))]).await;
    let pack = super::super::cred::CredPack {
        cookie: "pacmtoken=fixture-token".into(),
        ..Default::default()
    };
    let track_ref = json!({"contentId": "600902000006889366", "copyrightId": "60054701923"});
    let error = fixture
        .api(Some(&pack))
        .stream("60054701923", Some(&track_ref))
        .await
        .unwrap_err();
    assert_eq!(error.code, "vip_required");
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].headers["pacmtoken"], "fixture-token");
}

#[tokio::test]
async fn stream_does_not_treat_a_missing_resource_as_a_login_error() {
    let fixture = upstream(vec![Reply::json(json!({"code": "000000", "resource": []}))]).await;
    let error = fixture.api(None).stream("missing", None).await.unwrap_err();
    assert_eq!(error.code, "upstream_rejected");
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn stream_http_failure_cannot_be_overridden_by_a_valid_body() {
    let fixture = upstream(vec![Reply {
        status: StatusCode::BAD_GATEWAY,
        chunks: vec![envelope(public_stream())],
        finish: true,
    }])
    .await;
    let track_ref = json!({"contentId": "content"});
    let error = fixture
        .api(None)
        .stream("track", Some(&track_ref))
        .await
        .unwrap_err();
    assert_eq!(error.code, "upstream_rejected");
    assert!(error.message.contains("502"));
}

#[test]
fn vip_on_a_higher_quality_does_not_label_standard_audio_as_member_only() {
    let track = map_track(&json!({
        "copyrightId": "public", "name": "普通曲目", "vipType": "1",
        "newRateFormats": [{"formatType": "PQ"}, {"formatType": "HQ", "showTag": ["vip"]}]
    }))
    .unwrap();
    assert!(!track.vip_only);
    assert!(track.playable);
}

#[tokio::test]
#[ignore = "read-only public Migu acceptance; run explicitly with network access"]
async fn live_public_migu_contract() {
    // Do not construct a Ctx or access the credential vault in this acceptance test.
    let api = MiguApi::new(None).unwrap();
    assert_eq!(api.account().await.unwrap_err().code, "auth_required");
    let invalid = super::super::cred::CredPack {
        cookie: "pacmtoken=migu-integration-invalid".into(),
        ..Default::default()
    };
    assert_eq!(
        MiguApi::new(Some(&invalid))
            .unwrap()
            .account()
            .await
            .unwrap_err()
            .code,
        "auth_required"
    );
    println!("LIVE Migu anonymous and synthetic invalid account: auth_required");

    let first = api.playlist_detail("135423084", 0, 100).await.unwrap();
    assert!(first.total >= 100);
    assert_eq!(first.tracks.len(), 100);
    let cross = api.playlist_detail("135423084", 49, 3).await.unwrap();
    assert_eq!(cross.total, first.total);
    assert_eq!(
        cross
            .tracks
            .iter()
            .map(|track| &track.id)
            .collect::<Vec<_>>(),
        first.tracks[49..52]
            .iter()
            .map(|track| &track.id)
            .collect::<Vec<_>>()
    );
    let tail_offset = first.total.saturating_sub(2) as usize;
    let tail = api
        .playlist_detail("135423084", tail_offset, 50)
        .await
        .unwrap();
    assert_eq!(tail.total, first.total);
    assert_eq!(tail.tracks.len(), 2);
    let empty = api
        .playlist_detail("135423084", first.total as usize + 1, 50)
        .await
        .unwrap();
    assert_eq!(empty.total, first.total);
    assert!(empty.tracks.is_empty());
    println!(
        "LIVE Migu playlist: total={}, first={}, offset49={}, tail={}, beyond_end={}",
        first.total,
        first.tracks.len(),
        cross.tracks.len(),
        tail.tracks.len(),
        empty.tracks.len()
    );

    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        api.stream("60058621415", None),
    )
    .await
    .expect("public stream respects the overall acceptance deadline")
    .unwrap();
    assert!(stream.bitrate.is_none());
    let response = api
        .http
        .get(&stream.url)
        .headers(headers())
        .header(reqwest::header::RANGE, "bytes=0-63")
        .send()
        .await
        .map_err(super::super::http::send_error)
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(media_type.starts_with("audio/mpeg"));
    let host = response.url().host_str().unwrap().to_string();
    let sample = read_response(response).await.unwrap();
    assert_eq!(sample.len(), 64);
    assert_eq!(&sample[..3], b"ID3");
    println!("LIVE Migu public stream without ref: Range=206, type={media_type}, host={host}, sample=64/ID3, bitrate=None");

    let denied = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        api.stream("60054701923", None),
    )
    .await
    .expect("member stream respects the overall acceptance deadline")
    .unwrap_err();
    assert_eq!(denied.code, "vip_required");
    println!("LIVE Migu member track: vip_required; valid personal account acceptance remains unverified");
}
