// SPDX-License-Identifier: MIT
//! Native negotiation races and shared PCM ownership over real pinned TLS/WSS.
use futures::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;
use vmusic_lan::client::{self, ClientConnection, ConnectionMode, ConnectionState};
use vmusic_lan::clock::MonotonicClock;
use vmusic_lan::members::{Paired, Permissions};
use vmusic_lan::protocol::{
    required_capabilities, AudioFormat, ControlFrame, Counter, FormatMode, Plan, StreamIdentity,
    CAPABILITIES, VERSION,
};
use vmusic_lan::server::{Inbound, RoomServer, ROOM_PATH};
use vmusic_lan::tls::{self, HostIdentity};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

async fn raw_socket(server: &RoomServer) -> Socket {
    let tls = tls::connect(server.address, server.fingerprint)
        .await
        .unwrap();
    tokio_tungstenite::client_async(format!("wss://{}{ROOM_PATH}", server.address), tls)
        .await
        .unwrap()
        .0
}

async fn frame(socket: &mut Socket) -> Option<ControlFrame> {
    match tokio::time::timeout(Duration::from_secs(6), socket.next())
        .await
        .unwrap()
    {
        Some(Ok(Message::Text(text))) => Some(ControlFrame::decode(&text).unwrap()),
        _ => None,
    }
}

async fn write(socket: &mut Socket, frame: ControlFrame) {
    socket
        .send(Message::Text(frame.encode().unwrap().into()))
        .await
        .unwrap();
}

async fn native_room() -> (
    RoomServer,
    tokio::sync::mpsc::Receiver<Inbound>,
    Paired,
    Uuid,
) {
    let host = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, inbound) = RoomServer::bind_with_mode(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &host,
        MonotonicClock::default(),
        FormatMode::Native,
    )
    .await
    .unwrap();
    let invitation = server.transport.invite(Permissions::default()).unwrap();
    let paired = client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation,
        "native peer",
    )
    .await
    .unwrap();
    (server, inbound, paired, room)
}

async fn authenticate(socket: &mut Socket, paired: &Paired, room: Uuid) -> StreamIdentity {
    socket
        .send(Message::Text(
            serde_json::json!({
                "channel":"control", "version":VERSION, "room_id":room,
                "member_id":paired.member_id, "credential":paired.credential.expose(),
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let Some(ControlFrame::Hello {
        identity, required, ..
    }) = frame(socket).await
    else {
        panic!("missing Hello");
    };
    assert_eq!(required, required_capabilities(FormatMode::Native));
    identity
}

fn supported() -> Vec<String> {
    CAPABILITIES.iter().map(|c| c.to_string()).collect()
}
fn plan() -> Plan {
    Plan {
        epoch: Counter(7),
        plan_id: Counter(11),
        anchor_ns: Counter(1),
        join_frame: Counter(0),
        format: AudioFormat {
            id: 9,
            sample_rate: 192_000,
            channels: 2,
        },
    }
}

#[tokio::test]
async fn native_ack_barrier_rejects_early_audio_and_conflicting_retry() {
    let (server, mut inbound, paired, room) = native_room().await;
    let mut control = raw_socket(&server).await;
    let identity = authenticate(&mut control, &paired, room).await;
    assert!(inbound.try_recv().is_err());
    assert!(server
        .transport
        .send(
            paired.member_id,
            identity,
            &ControlFrame::Prepare { plan: plan() }
        )
        .is_err());

    let mut early = raw_socket(&server).await;
    early
        .send(Message::Text(
            serde_json::json!({"channel":"audio","version":VERSION,
        "identity":identity,"member_id":paired.member_id,"credential":paired.credential.expose()})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert!(frame(&mut early).await.is_none());
    assert!(
        inbound.try_recv().is_err(),
        "early audio acquired a lease or notified the app"
    );

    let mut capabilities = supported();
    capabilities.push("legal_optional".into());
    write(
        &mut control,
        ControlFrame::CapabilityAck {
            supported: capabilities.clone(),
        },
    )
    .await;
    assert!(matches!(
        frame(&mut control).await,
        Some(ControlFrame::CapabilityConfirmed {})
    ));
    assert!(
        matches!(inbound.recv().await, Some(Inbound::Connected { identity: i, .. }) if i == identity)
    );
    write(
        &mut control,
        ControlFrame::CapabilityAck {
            supported: capabilities,
        },
    )
    .await;
    assert!(matches!(
        frame(&mut control).await,
        Some(ControlFrame::CapabilityConfirmed {})
    ));
    assert!(
        inbound.try_recv().is_err(),
        "idempotent ack repeated Connected"
    );
    write(
        &mut control,
        ControlFrame::CapabilityAck {
            supported: supported(),
        },
    )
    .await;
    assert!(frame(&mut control).await.is_none());
    assert!(matches!(
        inbound.recv().await,
        Some(Inbound::Disconnected { .. })
    ));
    assert!(server
        .transport
        .authorize(paired.member_id, identity)
        .is_err());
    server.shutdown().await;
}

#[tokio::test]
async fn native_wrong_direction_and_business_before_ack_never_reach_owner() {
    for injected in [
        ControlFrame::Request {
            request_id: Counter(1),
            body: serde_json::json!({"action":"snapshot"}),
        },
        ControlFrame::CapabilityConfirmed {},
        ControlFrame::Prepare { plan: plan() },
        ControlFrame::EpochEnd {
            epoch: Counter(7),
            format_id: 9,
            end_frame: Counter(1),
        },
    ] {
        let (server, mut inbound, paired, room) = native_room().await;
        let mut socket = raw_socket(&server).await;
        authenticate(&mut socket, &paired, room).await;
        write(&mut socket, injected).await;
        assert!(frame(&mut socket).await.is_none());
        while let Ok(event) = inbound.try_recv() {
            assert!(matches!(event, Inbound::Disconnected { .. }));
        }
        server.shutdown().await;
    }
}

#[tokio::test]
async fn missing_native_capability_has_a_reason_and_releases_session() {
    let (server, mut inbound, paired, room) = native_room().await;
    let mut socket = raw_socket(&server).await;
    let identity = authenticate(&mut socket, &paired, room).await;
    write(
        &mut socket,
        ControlFrame::CapabilityAck {
            supported: required_capabilities(FormatMode::Fixed)
                .iter()
                .map(|c| c.to_string())
                .collect(),
        },
    )
    .await;
    assert!(
        matches!(frame(&mut socket).await, Some(ControlFrame::End { reason }) if reason == "native_rate_capability_required")
    );
    drop(socket);
    assert!(matches!(
        inbound.recv().await,
        Some(Inbound::Disconnected { .. })
    ));
    assert!(server
        .transport
        .authorize(paired.member_id, identity)
        .is_err());
    server.shutdown().await;
}

#[tokio::test]
async fn native_plan_end_and_pcm_share_the_transferred_input_reservation() {
    let (server, mut inbound, paired, room) = native_room().await;
    let (connection, mut events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        paired.member_id,
        &paired.credential,
    )
    .await
    .unwrap();
    assert_eq!(connection.handle.format_mode, FormatMode::Native);
    let identity = connection.handle.identity;
    loop {
        if matches!(inbound.recv().await, Some(Inbound::AudioAttached { .. })) {
            break;
        }
    }
    let plan = plan();
    server
        .transport
        .send(
            paired.member_id,
            identity,
            &ControlFrame::Prepare { plan: plan.clone() },
        )
        .unwrap();
    let Some(ControlFrame::Prepare { .. }) = events.control.recv().await else {
        panic!("missing Prepare");
    };
    server
        .transport
        .send(
            paired.member_id,
            identity,
            &ControlFrame::EpochEnd {
                epoch: plan.epoch,
                format_id: plan.format.id,
                end_frame: Counter(3840),
            },
        )
        .unwrap();
    assert!(matches!(
        events.control.recv().await,
        Some(ControlFrame::EpochEnd {
            end_frame: Counter(3840),
            ..
        })
    ));
    assert_eq!(
        server
            .transport
            .broadcast_pcm(7, 1, 0, plan.format, vec![0.0; 3840 * 2].into())
            .unwrap(),
        1
    );
    let received = tokio::time::timeout(Duration::from_secs(2), events.audio.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(events.pcm_budget.input_duration_ns(), 20_000_000);
    let (block, reservation) = received.into_parts();
    assert!(reservation.is_from(&connection.handle.pcm_budget()));
    assert_eq!(block.frame_count(), 3840);
    assert_eq!(
        events.pcm_budget.input_duration_ns(),
        20_000_000,
        "handoff released ingress ownership"
    );
    drop((block, reservation));
    assert_eq!(events.pcm_budget.input_bytes(), 0);
    connection.shutdown().await;
    server.shutdown().await;
}

#[tokio::test]
async fn native_multi_rate_epochs_preserve_pcm_bits_and_exact_endpoints() {
    let (server, mut inbound, paired, room) = native_room().await;
    let (connection, mut events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        paired.member_id,
        &paired.credential,
    )
    .await
    .unwrap();
    loop {
        if matches!(inbound.recv().await, Some(Inbound::AudioAttached { .. })) {
            break;
        }
    }
    let identity = connection.handle.identity;
    let first_frame = 9_007_199_254_740_993u64;
    for (index, rate) in [44_100, 48_000, 96_000, 192_000, 44_100, 88_200, 176_400]
        .into_iter()
        .enumerate()
    {
        let epoch = index as u64 + 1;
        let format = AudioFormat {
            id: index as u32 + 1,
            sample_rate: rate,
            channels: 2,
        };
        let plan = Plan {
            epoch: Counter(epoch),
            plan_id: Counter(epoch),
            anchor_ns: Counter(u64::MAX),
            join_frame: Counter(first_frame),
            format,
        };
        server
            .transport
            .send(
                paired.member_id,
                identity,
                &ControlFrame::Prepare { plan: plan.clone() },
            )
            .unwrap();
        assert!(
            matches!(events.control.recv().await, Some(ControlFrame::Prepare { plan: p }) if p == plan)
        );
        let end_frame = first_frame + 3;
        server
            .transport
            .send(
                paired.member_id,
                identity,
                &ControlFrame::EpochEnd {
                    epoch: Counter(epoch),
                    format_id: format.id,
                    end_frame: Counter(end_frame),
                },
            )
            .unwrap();
        assert!(
            matches!(events.control.recv().await, Some(ControlFrame::EpochEnd { epoch: Counter(e), format_id, end_frame: Counter(end) }) if e == epoch && format_id == format.id && end == end_frame)
        );
        for (sequence, offset, bits) in [
            (1, 0, vec![0x00000000, 0x80000000, 0x3f000001, 0xbf000002]),
            (2, 2, vec![0x3e800003, 0xbe800004]),
        ] {
            let samples = bits
                .iter()
                .map(|bits| f32::from_bits(*bits))
                .collect::<Vec<_>>();
            assert_eq!(
                server
                    .transport
                    .broadcast_pcm(
                        epoch,
                        sequence,
                        first_frame + offset,
                        format,
                        samples.into()
                    )
                    .unwrap(),
                1
            );
            let received = tokio::time::timeout(Duration::from_secs(2), events.audio.recv())
                .await
                .unwrap()
                .unwrap();
            let (block, reservation) = received.into_parts();
            assert_eq!(block.epoch, epoch);
            assert_eq!(block.format_id, format.id);
            assert_eq!(block.sequence, sequence);
            assert_eq!(block.frame_index, first_frame + offset);
            assert_eq!(
                block
                    .samples
                    .iter()
                    .map(|sample| sample.to_bits())
                    .collect::<Vec<_>>(),
                bits
            );
            assert!(block.end_frame() <= end_frame);
            assert_eq!(
                reservation.duration_ns(),
                (u64::from(block.frame_count()) * 1_000_000_000).div_ceil(u64::from(rate))
            );
            assert!(reservation.is_from(&events.pcm_budget));
            drop((block, reservation));
            assert_eq!(events.pcm_budget.input_bytes(), 0);
        }
    }
    connection.shutdown().await;
    server.shutdown().await;
    assert_eq!(events.pcm_budget.bytes(), 0);
}

#[tokio::test]
async fn native_control_only_member_negotiates_without_acquiring_audio() {
    let (server, mut inbound, paired, room) = native_room().await;
    let (connection, _) = ClientConnection::connect_mode(
        server.address,
        server.fingerprint,
        room,
        paired.member_id,
        &paired.credential,
        ConnectionMode::ControlOnly,
    )
    .await
    .unwrap();
    assert_eq!(connection.handle.format_mode, FormatMode::Native);
    assert!(matches!(
        inbound.recv().await,
        Some(Inbound::Connected { .. })
    ));
    assert!(inbound.try_recv().is_err());
    connection.shutdown().await;
    server.shutdown().await;
}

#[tokio::test]
async fn client_opens_audio_only_after_native_confirmation() {
    let host = HostIdentity::generate().unwrap();
    let fingerprint = host.fingerprint();
    let room = Uuid::new_v4();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(host.server_config().unwrap());
    let credential = vmusic_lan::members::Secret::generate().unwrap();
    let connecting = tokio::spawn(async move {
        ClientConnection::connect_mode(
            address,
            fingerprint,
            room,
            Uuid::new_v4(),
            &credential,
            ConnectionMode::Listening,
        )
        .await
    });
    let (tcp, _) = listener.accept().await.unwrap();
    let mut control = tokio_tungstenite::accept_async(acceptor.accept(tcp).await.unwrap())
        .await
        .unwrap();
    assert!(matches!(
        control.next().await.unwrap().unwrap(),
        Message::Text(_)
    ));
    let identity = StreamIdentity {
        room_id: room,
        instance_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
    };
    let hello = ControlFrame::Hello {
        version: VERSION,
        identity,
        required: supported(),
    };
    control
        .send(Message::Text(hello.encode().unwrap().into()))
        .await
        .unwrap();
    let Message::Text(text) = control.next().await.unwrap().unwrap() else {
        panic!("missing ack");
    };
    assert!(matches!(
        ControlFrame::decode(&text).unwrap(),
        ControlFrame::CapabilityAck { .. }
    ));
    assert!(!connecting.is_finished());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), control.next())
            .await
            .is_err(),
        "business traffic began before confirmation"
    );
    control
        .send(Message::Text(
            ControlFrame::CapabilityConfirmed {}
                .encode()
                .unwrap()
                .into(),
        ))
        .await
        .unwrap();
    let (tcp, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut audio = tokio_tungstenite::accept_async(acceptor.accept(tcp).await.unwrap())
        .await
        .unwrap();
    assert!(matches!(
        audio.next().await.unwrap().unwrap(),
        Message::Text(_)
    ));
    let (connection, mut events) = connecting.await.unwrap().unwrap();
    control
        .send(Message::Text(
            ControlFrame::CapabilityConfirmed {}
                .encode()
                .unwrap()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        events
            .state
            .wait_for(|state| matches!(state, ConnectionState::Closed { .. })),
    )
    .await
    .unwrap()
    .unwrap();
    connection.shutdown().await;
}

#[tokio::test]
async fn native_ack_does_not_restart_the_total_handshake_deadline() {
    let (server, mut inbound, paired, room) = native_room().await;
    let began = tokio::time::Instant::now();
    let mut socket = raw_socket(&server).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    let identity = authenticate(&mut socket, &paired, room).await;
    assert!(frame(&mut socket).await.is_none());
    assert!(
        began.elapsed() < Duration::from_millis(5_400),
        "native handshake restarted after authentication"
    );
    assert!(matches!(
        inbound.recv().await,
        Some(Inbound::Disconnected { .. })
    ));
    assert!(server
        .transport
        .authorize(paired.member_id, identity)
        .is_err());
    assert_eq!(server.transport.buffered_bytes(), 0);
    server.shutdown().await;
}
