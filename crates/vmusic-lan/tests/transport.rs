// SPDX-License-Identifier: MIT
//! Real loopback TCP/TLS/WSS. No soundcard or permissive certificate verifier.
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;
use vmusic_lan::client::{self, ClientConnection, ClientEvents, ConnectionState};
use vmusic_lan::clock::MonotonicClock;
use vmusic_lan::members::Permissions;
use vmusic_lan::protocol::{AudioFormat, ControlFrame, Counter, Plan, StreamIdentity, VERSION};
use vmusic_lan::server::{Inbound, RoomServer};
use vmusic_lan::tls::HostIdentity;

async fn control(events: &mut ClientEvents) -> ControlFrame {
    tokio::time::timeout(Duration::from_secs(3), events.control.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn lobby_artwork_is_public_bounded_pinned_and_never_pairs_a_member() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use vmusic_lan::lobby::{LobbyProfile, COVER_PREFIX};
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
    assert!(
        client::lobby_profile(server.address, server.fingerprint, room)
            .await
            .unwrap()
            .is_none()
    );
    let mut png = Vec::new();
    {
        let encoder = png::Encoder::new(&mut png, 2, 2);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[128; 4])
            .unwrap();
    }
    let cover = format!("{COVER_PREFIX}{}", STANDARD.encode(png));
    server
        .transport
        .set_lobby_profile(Some(LobbyProfile {
            room_id: room,
            cover: Some(cover.clone()),
        }))
        .unwrap();
    let profile = client::lobby_profile(server.address, server.fingerprint, room)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(profile.cover.as_deref(), Some(cover.as_str()));
    assert_eq!(
        serde_json::to_value(profile)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert!(server.transport.members().is_empty());
    assert!(inbound.try_recv().is_err());
    assert!(
        client::lobby_profile(server.address, server.fingerprint, Uuid::new_v4())
            .await
            .is_err()
    );
    assert!(client::lobby_profile(
        server.address,
        vmusic_lan::tls::Fingerprint::of(b"wrong"),
        room
    )
    .await
    .is_err());
    assert!(server
        .transport
        .set_lobby_profile(Some(LobbyProfile {
            room_id: room,
            cover: Some("data:image/png;base64,bm90IHBuZw==".into())
        }))
        .is_err());
    assert_eq!(
        client::lobby_profile(server.address, server.fingerprint, room)
            .await
            .unwrap()
            .unwrap()
            .cover,
        Some(cover)
    );
    server.transport.set_lobby_profile(None).unwrap();
    assert!(
        client::lobby_profile(server.address, server.fingerprint, room)
            .await
            .unwrap()
            .is_none()
    );
    let invitation = server.transport.invite(Permissions::default()).unwrap();
    client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation,
        "real member",
    )
    .await
    .unwrap();
    assert_eq!(
        server.transport.members().len(),
        1,
        "only normal invitation pairing grants membership"
    );
    server.shutdown().await;
}

type PeerSocket =
    tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<tokio::net::TcpStream>>;

async fn accept_scripted_peer(
    listener: &tokio::net::TcpListener,
    acceptor: &tokio_rustls::TlsAcceptor,
) -> PeerSocket {
    tokio::time::timeout(Duration::from_secs(2), async {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = acceptor.accept(tcp).await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tls).await.unwrap();
        assert!(matches!(
            socket.next().await.unwrap().unwrap(),
            tokio_tungstenite::tungstenite::Message::Text(_)
        ));
        socket
    })
    .await
    .unwrap()
}

// Keep each peer socket under test control so EOF and a delayed End cannot be
// confused with RoomServer's normal membership invalidation during Drop.
async fn scripted_connection(
    mode: client::ConnectionMode,
) -> (
    ClientConnection,
    ClientEvents,
    PeerSocket,
    Option<PeerSocket>,
) {
    let host = HostIdentity::generate().unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(host.server_config().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fingerprint = host.fingerprint();
    let room = Uuid::new_v4();
    let identity = StreamIdentity {
        room_id: room,
        instance_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
    };
    let connecting = tokio::spawn(async move {
        let credential = vmusic_lan::members::Secret::generate().unwrap();
        ClientConnection::connect_mode(
            address,
            fingerprint,
            room,
            Uuid::new_v4(),
            &credential,
            mode,
        )
        .await
        .unwrap()
    });
    let mut control = accept_scripted_peer(&listener, &acceptor).await;
    let hello = ControlFrame::Hello {
        version: VERSION,
        identity,
        required: vec![],
    };
    control
        .send(tokio_tungstenite::tungstenite::Message::Text(
            hello.encode().unwrap().into(),
        ))
        .await
        .unwrap();
    let audio = if mode == client::ConnectionMode::Listening {
        Some(accept_scripted_peer(&listener, &acceptor).await)
    } else {
        None
    };
    let (connection, events) = connecting.await.unwrap();
    (connection, events, control, audio)
}

async fn closed(events: &mut ClientEvents) -> ConnectionState {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !matches!(*events.state.borrow(), ConnectionState::Closed { .. }) {
            events.state.changed().await.unwrap();
        }
        events.state.borrow().clone()
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn legacy_queue_protocol_handshake_cannot_pair_or_consume_an_invitation() {
    let host = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, _inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &host,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let invitation = server.transport.invite(Permissions::default()).unwrap();
    let tls = vmusic_lan::tls::connect(server.address, server.fingerprint)
        .await
        .unwrap();
    let (mut socket, _) = tokio_tungstenite::client_async(
        format!("wss://{}{}", server.address, vmusic_lan::server::ROOM_PATH),
        tls,
    )
    .await
    .unwrap();
    let request = serde_json::json!({"channel":"pair","version":1,"room_id":room,
        "invitation":invitation.expose(),"name":"legacy"});
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            request.to_string().into(),
        ))
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    assert!(!matches!(
        response,
        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(_)))
    ));
    assert!(server.transport.members().is_empty());
    client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation,
        "version two",
    )
    .await
    .unwrap();
    assert_eq!(server.transport.members().len(), 1);
    server.shutdown().await;
}
#[tokio::test]
async fn normal_room_shutdown_delivers_terminal_end_before_connection_tasks_are_cancelled() {
    for mode in [
        client::ConnectionMode::ControlOnly,
        client::ConnectionMode::Listening,
    ] {
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
        let secret = server.transport.invite(Permissions::default()).unwrap();
        let paired = client::pair(
            server.address,
            server.fingerprint,
            room,
            &secret,
            "control only",
        )
        .await
        .unwrap();
        let (connection, mut events) = ClientConnection::connect_mode(
            server.address,
            server.fingerprint,
            room,
            paired.member_id,
            &paired.credential,
            mode,
        )
        .await
        .unwrap();
        if mode == client::ConnectionMode::Listening {
            tokio::time::timeout(Duration::from_secs(2), async {
                while !matches!(inbound.recv().await, Some(Inbound::AudioAttached { .. })) {}
            })
            .await
            .unwrap();
        }
        // Match the guest's startup snapshot and output update. These must not
        // hide an End already being delivered when the host closes the room.
        connection
            .handle
            .send(ControlFrame::Request {
                request_id: Counter(1),
                body: serde_json::json!({"action":"snapshot"}),
            })
            .unwrap();
        connection.handle.output_status(client::OutputStatus {
            ready: true,
            ..Default::default()
        });
        server.shutdown().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while !matches!(*events.state.borrow(), ConnectionState::Closed { .. }) {
                events.state.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(
            matches!(
                *events.state.borrow(),
                ConnectionState::Closed { terminal: true, .. }
            ),
            "{mode:?}: {:?}",
            *events.state.borrow()
        );
        connection.shutdown().await;
    }
}
#[tokio::test]
async fn abrupt_room_transport_loss_is_reconnectable_without_a_terminal_end() {
    for mode in [
        client::ConnectionMode::ControlOnly,
        client::ConnectionMode::Listening,
    ] {
        let (connection, mut events, control, audio) = scripted_connection(mode).await;
        drop((control, audio));
        let state = closed(&mut events).await;
        assert!(
            matches!(
                state,
                ConnectionState::Closed {
                    terminal: false,
                    ..
                }
            ),
            "{mode:?}: {state:?}"
        );
        connection.shutdown().await;
    }
}

#[tokio::test]
async fn wifi_stall_and_retired_clock_replies_do_not_disconnect_an_established_peer() {
    use tokio_tungstenite::tungstenite::Message;
    let (connection, mut events, mut control, _audio) =
        scripted_connection(client::ConnectionMode::Listening).await;
    // Keep TCP alive but withhold all server traffic. This exceeds the old
    // five-second liveness limit and evicts startup probes from the bounded
    // pending window. Clock freshness must still expire independently.
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(*events.state.borrow(), ConnectionState::Connected);
    assert!(events.mapping.borrow().is_none());
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut replied = 0;
        while replied < 40 {
            let Message::Text(text) = control.next().await.unwrap().unwrap() else {
                continue;
            };
            if let ControlFrame::TimeRequest { sequence, t1 } = ControlFrame::decode(&text).unwrap()
            {
                let now = connection.handle.clock().now_ns();
                let response = ControlFrame::TimeResponse {
                    sequence,
                    t1,
                    t2: Counter(now),
                    t3: Counter(now),
                };
                control
                    .send(Message::Text(response.encode().unwrap().into()))
                    .await
                    .unwrap();
                replied += 1;
            }
        }
        // A reliable response after the obsolete probes proves the receive
        // loop survived them; merely checking state could race its teardown.
        control
            .send(Message::Text(
                ControlFrame::Response {
                    request_id: Counter(1),
                    body: serde_json::json!({"resumed":true}),
                }
                .encode()
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        let frame = events.control.recv().await.unwrap();
        assert!(matches!(frame, ControlFrame::Response { body, .. } if body["resumed"] == true));
    })
    .await
    .unwrap();
    assert_eq!(*events.state.borrow(), ConnectionState::Connected);
    assert!(
        events.mapping.borrow().is_none(),
        "delayed probes cannot renew synchronization"
    );
    connection.shutdown().await;
}

#[tokio::test]
async fn audio_loss_mutes_immediately_and_keeps_consumers_alive_for_the_terminal_end() {
    let (connection, mut events, mut control, audio) =
        scripted_connection(client::ConnectionMode::Listening).await;
    drop(audio);
    tokio::time::timeout(Duration::from_secs(2), async {
        while *events.state.borrow() == ConnectionState::Connected {
            events.state.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        *events.state.borrow(),
        ConnectionState::Closing { .. }
    ));
    assert!(matches!(
        events.audio.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    assert!(matches!(
        events.control.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    let end = ControlFrame::End {
        reason: "room_authorization_expired".into(),
    };
    control
        .send(tokio_tungstenite::tungstenite::Message::Text(
            end.encode().unwrap().into(),
        ))
        .await
        .unwrap();
    assert!(matches!(
        closed(&mut events).await,
        ConnectionState::Closed { terminal: true, .. }
    ));
    connection.shutdown().await;
}

#[tokio::test]
async fn audio_loss_with_silent_control_has_a_bounded_reconnectable_close() {
    let (connection, mut events, _silent_control, audio) =
        scripted_connection(client::ConnectionMode::Listening).await;
    drop(audio);
    assert!(matches!(
        closed(&mut events).await,
        ConnectionState::Closed {
            terminal: false,
            ..
        }
    ));
    connection.shutdown().await;
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
    let samples: Arc<[f32]> = (0..1920)
        .map(|i| if i == 0 { -0.0 } else { i as f32 / 4096.0 })
        .collect::<Vec<_>>()
        .into();
    // A new listener may spend longer than the receiver's 500ms match
    // window calibrating its clock. Audio attachment alone is not a plan.
    assert_eq!(
        server
            .transport
            .broadcast_pcm(1, 0, 0, format, samples.clone())
            .unwrap(),
        0,
        "do not send PCM before the endpoint's first Prepare"
    );
    assert_eq!(server.transport.buffered_bytes(), 0);
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
    // A second listener attaches while the first is already receiving PCM.
    // Its clock warmup must neither receive unmatched PCM nor interrupt the
    // established endpoint. Delivery starts on Prepare, before Ready/Commit.
    let invitation = server.transport.invite(Permissions::default()).unwrap();
    let newcomer = client::pair(
        server.address,
        server.fingerprint,
        room_id,
        &invitation,
        "刚加入的电脑",
    )
    .await
    .unwrap();
    let (new_connection, mut new_events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room_id,
        newcomer.member_id,
        &newcomer.credential,
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(inbound.recv().await, Some(Inbound::AudioAttached { member_id, .. }) if member_id == newcomer.member_id) {
                break;
            }
        }
    }).await.unwrap();
    assert_eq!(
        server
            .transport
            .broadcast_pcm(1, 2, 960, format, samples.clone())
            .unwrap(),
        1
    );
    let established = tokio::time::timeout(Duration::from_secs(3), events.audio.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(established.block().sequence, 2);
    drop(established);
    assert!(new_events.audio.try_recv().is_err());
    server
        .transport
        .send(
            newcomer.member_id,
            new_connection.handle.identity,
            &ControlFrame::Prepare { plan: plan.clone() },
        )
        .unwrap();
    assert_eq!(
        server
            .transport
            .broadcast_pcm(1, 3, 1920, format, samples.clone())
            .unwrap(),
        2
    );
    for audio in [&mut events.audio, &mut new_events.audio] {
        let block = tokio::time::timeout(Duration::from_secs(3), audio.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block.block().sequence, 3);
    }
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
    let reconnect = ClientConnection::connect_mode(
        server.address,
        server.fingerprint,
        room_id,
        paired.member_id,
        &paired.credential,
        client::ConnectionMode::ControlOnly,
    )
    .await;
    assert!(matches!(
        reconnect,
        Err(client::ClientError::AuthorizationExpired)
    ));
    connection.shutdown().await;
    new_connection.shutdown().await;
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
