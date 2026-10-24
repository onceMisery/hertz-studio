// SPDX-License-Identifier: MIT
//! Real loopback TCP/TLS/WSS. No soundcard or permissive certificate verifier.
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;
use vmusic_lan::client::{self, ClientConnection, ClientEvents, ConnectionState};
use vmusic_lan::clock::MonotonicClock;
use vmusic_lan::members::Permissions;
use vmusic_lan::protocol::{AudioFormat, ControlFrame, Counter, Plan};
use vmusic_lan::server::{Inbound, RoomServer};
use vmusic_lan::tls::HostIdentity;

async fn control(events: &mut ClientEvents) -> ControlFrame {
    tokio::time::timeout(Duration::from_secs(3), events.control.recv())
        .await
        .unwrap()
        .unwrap()
}
#[tokio::test]
async fn pinned_pair_dual_stream_request_pcm_and_revocation_are_one_lifecycle() {
    let identity = HostIdentity::generate().unwrap();
    let room_id = Uuid::new_v4();
    let clock = MonotonicClock::default();
    let (server, mut inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room_id,
        Uuid::new_v4(),
        &identity,
        clock.clone(),
    )
    .await
    .unwrap();
    let invite = server.transport.invite(Permissions::default()).unwrap();
    assert!(client::pair(
        server.address,
        HostIdentity::generate().unwrap().fingerprint(),
        room_id,
        &invite,
        "wrong pin"
    )
    .await
    .is_err());
    let paired = client::pair(
        server.address,
        server.fingerprint,
        room_id,
        &invite,
        "客厅电脑",
    )
    .await
    .unwrap();
    assert!(client::pair(
        server.address,
        server.fingerprint,
        room_id,
        &invite,
        "replay"
    )
    .await
    .is_err());
    let (connection, mut events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room_id,
        paired.member_id,
        &paired.credential,
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(inbound.recv().await, Some(Inbound::AudioAttached { .. })) {
                break;
            }
        }
    })
    .await
    .unwrap();
    let stream = connection.handle.identity;
    let format = AudioFormat {
        id: 1,
        sample_rate: 48_000,
        channels: 2,
    };
    let plan = Plan {
        epoch: Counter(1),
        plan_id: Counter(1),
        anchor_ns: Counter(clock.now_ns() + 1_000_000_000),
        join_frame: Counter(0),
        format,
    };
    server
        .transport
        .send(
            paired.member_id,
            stream,
            &ControlFrame::Prepare { plan: plan.clone() },
        )
        .unwrap();
    assert!(
        matches!(control(&mut events).await, ControlFrame::Prepare { plan: actual } if actual == plan)
    );
    let samples: Arc<[f32]> = (0..1920)
        .map(|i| if i == 0 { -0.0 } else { i as f32 / 4096.0 })
        .collect::<Vec<_>>()
        .into();
    assert_eq!(
        server
            .transport
            .broadcast_pcm(1, 1, 0, format, samples.clone())
            .unwrap(),
        1
    );
    let received = tokio::time::timeout(Duration::from_secs(3), events.audio.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received.block().identity, stream);
    assert!(received
        .block()
        .samples
        .iter()
        .zip(samples.iter())
        .all(|(a, b)| a.to_bits() == b.to_bits()));
    drop(received);
    connection
        .handle
        .send(ControlFrame::Request {
            request_id: Counter(1),
            body: serde_json::json!({"action":"snapshot"}),
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Inbound::Request { body, reply, .. }) = inbound.recv().await {
                assert_eq!(body["action"], "snapshot");
                let _ = reply.send(serde_json::json!({"revision":"9007199254740993"}));
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(control(&mut events).await, ControlFrame::Response { request_id: Counter(1), body } if body["revision"] == "9007199254740993")
    );
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if events.mapping.borrow().is_some() {
                break;
            }
            events.mapping.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    server.transport.revoke(paired.member_id).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(&*events.state.borrow(), ConnectionState::Closed { .. }) {
                break;
            }
            events.state.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(server
        .transport
        .authorize(paired.member_id, stream)
        .is_err());
    connection.shutdown().await;
    tokio::time::timeout(Duration::from_secs(2), server.shutdown())
        .await
        .unwrap();
}

#[tokio::test]
async fn wrong_room_legacy_paths_browser_origins_and_wildcard_binds_are_rejected() {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let identity = HostIdentity::generate().unwrap();
    let room_id = Uuid::new_v4();
    assert!(RoomServer::bind(
        "0.0.0.0:0".parse().unwrap(),
        room_id,
        Uuid::new_v4(),
        &identity,
        MonotonicClock::default()
    )
    .await
    .is_err());
    let (server, _) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room_id,
        Uuid::new_v4(),
        &identity,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let invite = server.transport.invite(Permissions::default()).unwrap();
    assert!(client::pair(
        server.address,
        server.fingerprint,
        Uuid::new_v4(),
        &invite,
        "wrong room"
    )
    .await
    .is_err());
    for (path, origin) in [
        ("/api/library", false),
        ("/v1/room?token=forbidden", false),
        ("/v1/room", true),
    ] {
        let tls = vmusic_lan::tls::connect(server.address, server.fingerprint)
            .await
            .unwrap();
        let mut request = format!("wss://{}{path}", server.address)
            .into_client_request()
            .unwrap();
        if origin {
            request
                .headers_mut()
                .insert("origin", "http://localhost".parse().unwrap());
        }
        assert!(tokio_tungstenite::client_async(request, tls).await.is_err());
    }
    let tls = vmusic_lan::tls::connect(server.address, server.fingerprint)
        .await
        .unwrap();
    let (mut socket, _) =
        tokio_tungstenite::client_async(format!("wss://{}/v1/room", server.address), tls)
            .await
            .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text("{}".into()))
        .await
        .unwrap();
    server.shutdown().await;
}

#[tokio::test]
async fn control_only_members_keep_chat_and_request_access_without_audio_permission() {
    use vmusic_lan::client::ConnectionMode;
    let host = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, mut inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &host,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let permissions = Permissions {
        listen: false,
        chat_read: true,
        chat_send: true,
        ..Permissions::default()
    };
    let secret = server.transport.invite(permissions).unwrap();
    let paired = client::pair(
        server.address,
        server.fingerprint,
        room,
        &secret,
        "chat only",
    )
    .await
    .unwrap();
    let (connection, mut events) = ClientConnection::connect_mode(
        server.address,
        server.fingerprint,
        room,
        paired.member_id,
        &paired.credential,
        ConnectionMode::ControlOnly,
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            events.mapping.changed().await.unwrap();
            if events.mapping.borrow().is_some_and(|m| m.converged()) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(*events.state.borrow(), ConnectionState::Connected);
    connection
        .handle
        .send(ControlFrame::Request {
            request_id: Counter(1),
            body: serde_json::json!({"action":"chat_history"}),
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match inbound.recv().await.unwrap() {
                Inbound::AudioAttached { .. } => panic!("control-only client attached audio"),
                Inbound::Request { reply, .. } => {
                    reply.send(serde_json::json!({"messages":[]})).unwrap();
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        control(&mut events).await,
        ControlFrame::Response {
            request_id: Counter(1),
            ..
        }
    ));
    server
        .transport
        .notify_chat(&ControlFrame::Notification {
            topic: "chat_message".into(),
            body: serde_json::json!({"text":"hello"}),
        })
        .unwrap();
    let chat = tokio::time::timeout(Duration::from_secs(2), events.chat.recv())
        .await
        .unwrap();
    assert!(chat.contains("hello"));
    server.transport.revoke(paired.member_id).unwrap();
    tokio::time::timeout(Duration::from_secs(2), events.state.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        *events.state.borrow(),
        ConnectionState::Closed { .. }
    ));
    server.shutdown().await;
}
