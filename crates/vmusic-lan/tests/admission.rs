// SPDX-License-Identifier: MIT
//! Applicant isolation is checked through the real pinned TLS listener.
use uuid::Uuid;
use vmusic_lan::{
    client::{self, AdmissionStatus, ClientConnection},
    clock::MonotonicClock,
    members::{Permissions, Secret},
    server::RoomServer,
    tls::{Fingerprint, HostIdentity},
};

#[tokio::test]
async fn applicants_remain_isolated_until_host_approval_and_revocation_closes_the_capability() {
    let identity = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, mut inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &identity,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let code = server.transport.room_code();
    assert!(client::apply(
        server.address,
        Fingerprint::of(b"wrong"),
        room,
        &code,
        "Alice"
    )
    .await
    .is_err());
    let applied = client::apply(server.address, server.fingerprint, room, &code, "Alice")
        .await
        .unwrap();
    assert_eq!(server.transport.admission_views().len(), 1);
    assert!(server.transport.members().is_empty());
    assert!(inbound.try_recv().is_err());
    assert!(matches!(
        client::admission_status(
            server.address,
            server.fingerprint,
            room,
            applied.application_id,
            &applied.applicant_secret
        )
        .await
        .unwrap(),
        AdmissionStatus::Pending
    ));
    assert!(client::admission_status(
        server.address,
        server.fingerprint,
        room,
        applied.application_id,
        &Secret::generate().unwrap()
    )
    .await
    .is_err());
    // A poll secret is never a pairing invite or member credential.
    assert!(client::pair(
        server.address,
        server.fingerprint,
        room,
        &applied.applicant_secret,
        "unauthorized"
    )
    .await
    .is_err());
    assert!(ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        applied.application_id,
        &applied.applicant_secret
    )
    .await
    .is_err());
    assert!(server.transport.members().is_empty());
    assert!(inbound.try_recv().is_err());
    server
        .transport
        .review_admission(applied.application_id, true, Permissions::default())
        .unwrap();
    let AdmissionStatus::Approved(invitation) = client::admission_status(
        server.address,
        server.fingerprint,
        room,
        applied.application_id,
        &applied.applicant_secret,
    )
    .await
    .unwrap() else {
        panic!("missing approval")
    };
    assert!(server.transport.members().is_empty());
    server
        .transport
        .review_admission(applied.application_id, false, Permissions::default())
        .unwrap();
    assert!(client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation,
        "revoked"
    )
    .await
    .is_err());
    assert!(matches!(
        client::admission_status(
            server.address,
            server.fingerprint,
            room,
            applied.application_id,
            &applied.applicant_secret
        )
        .await
        .unwrap(),
        AdmissionStatus::Rejected
    ));
    let approved = client::apply(server.address, server.fingerprint, room, &code, "Bob")
        .await
        .unwrap();
    server
        .transport
        .review_admission(approved.application_id, true, Permissions::default())
        .unwrap();
    let AdmissionStatus::Approved(invitation) = client::admission_status(
        server.address,
        server.fingerprint,
        room,
        approved.application_id,
        &approved.applicant_secret,
    )
    .await
    .unwrap() else {
        panic!("missing approval")
    };
    // Prior failed pairing consumed two of the source's three burst credits.
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let member = client::pair(server.address, server.fingerprint, room, &invitation, "Bob")
        .await
        .unwrap();
    let host_view = server
        .transport
        .admission_views()
        .into_iter()
        .find(|v| v.id == approved.application_id)
        .unwrap();
    assert_eq!(host_view.state, "consumed");
    assert_eq!(host_view.member_id, Some(member.member_id));
    assert!(
        matches!(client::admission_status(server.address,server.fingerprint,room,approved.application_id,&approved.applicant_secret).await.unwrap(),AdmissionStatus::Consumed(id) if id==member.member_id)
    );
    assert!(server
        .transport
        .review_admission(approved.application_id, false, Permissions::default())
        .is_err());
    assert_eq!(server.transport.members().len(), 1);
    assert_eq!(server.transport.members().len(), 1);
    assert!(client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation,
        "replay"
    )
    .await
    .is_err());
    let (connection, _events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        member.member_id,
        &member.credential,
    )
    .await
    .unwrap();
    let peer = connection.handle.identity;
    assert!(server
        .transport
        .member_invite(member.member_id, peer)
        .is_err());
    server
        .transport
        .set_permissions(
            member.member_id,
            Permissions {
                invite: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert!(server
        .transport
        .member_invite(member.member_id, peer)
        .is_err());
    connection.shutdown().await;
    let (reconnected, _events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        member.member_id,
        &member.credential,
    )
    .await
    .unwrap();
    let invitation = server
        .transport
        .member_invite(member.member_id, reconnected.handle.identity)
        .unwrap();
    assert_eq!(invitation.secret.expose().len(), 64);
    server
        .transport
        .set_permissions(member.member_id, Permissions::default())
        .unwrap();
    assert!(server
        .transport
        .member_invite(member.member_id, reconnected.handle.identity)
        .is_err());
    reconnected.shutdown().await;
    server.transport.end();
    assert!(server.transport.admission_views().is_empty());
}

#[tokio::test]
async fn exhausted_invitation_capacity_leaves_the_application_pending() {
    let identity = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, _inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &identity,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let applied = client::apply(
        server.address,
        server.fingerprint,
        room,
        &server.transport.room_code(),
        "Alice",
    )
    .await
    .unwrap();
    for _ in 0..vmusic_lan::members::MAX_INVITATIONS {
        server.transport.invite(Permissions::default()).unwrap();
    }
    assert!(server
        .transport
        .review_admission(applied.application_id, true, Permissions::default())
        .is_err());
    assert!(matches!(
        client::admission_status(
            server.address,
            server.fingerprint,
            room,
            applied.application_id,
            &applied.applicant_secret
        )
        .await
        .unwrap(),
        AdmissionStatus::Pending
    ));
    assert!(server.transport.members().is_empty());
    assert_eq!(server.transport.admission_views()[0].state, "pending");
}

#[tokio::test]
async fn direct_invitation_revocation_and_consumption_are_distinct_from_membership_removal() {
    let identity = HostIdentity::generate().unwrap();
    let room = Uuid::new_v4();
    let (server, _inbound) = RoomServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        room,
        Uuid::new_v4(),
        &identity,
        MonotonicClock::default(),
    )
    .await
    .unwrap();
    let invitation = server
        .transport
        .issue_invitation(Permissions::default())
        .unwrap();
    assert_eq!(server.transport.invitation_views()[0].id, invitation.id);
    server
        .transport
        .revoke_invitation(invitation.id, None)
        .unwrap();
    assert!(server.transport.invitation_views().is_empty());
    assert!(client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation.secret,
        "revoked"
    )
    .await
    .is_err());
    let invitation = server
        .transport
        .issue_invitation(Permissions::default())
        .unwrap();
    let member = client::pair(
        server.address,
        server.fingerprint,
        room,
        &invitation.secret,
        "joined",
    )
    .await
    .unwrap();
    assert!(server.transport.invitation_views().is_empty());
    assert!(server
        .transport
        .revoke_invitation(invitation.id, None)
        .is_err());
    let (connection, _events) = ClientConnection::connect(
        server.address,
        server.fingerprint,
        room,
        member.member_id,
        &member.credential,
    )
    .await
    .unwrap();
    assert!(server
        .transport
        .authorize(member.member_id, connection.handle.identity)
        .is_ok());
    connection.shutdown().await;
}
