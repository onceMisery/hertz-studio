// SPDX-License-Identifier: MIT
use super::*;
use std::net::Shutdown;
use std::sync::atomic::AtomicUsize;
use std::sync::Barrier;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("hertz-window-test-{}", uuid::Uuid::new_v4())))
    }

    fn instance(&self, edition: &str, bind: &str, port: u16) -> Instance {
        Instance::new(&self.0, edition, bind, port).unwrap()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        // Only this test's freshly generated temporary directory is removed.
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn publish(instance: &Instance) -> (Owner, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let called = calls.clone();
    let mut owner = instance.try_claim().unwrap().unwrap();
    owner
        .publish(move || {
            called.fetch_add(1, Ordering::SeqCst);
            true
        })
        .unwrap();
    (owner, calls)
}

fn valid_request(doc: &Discovery) -> Request {
    let nonce = uuid::Uuid::new_v4().to_string();
    Request {
        protocol: PROTOCOL.into(),
        identity: doc.identity.clone(),
        instance: doc.instance.clone(),
        proof: signature(doc, &nonce, "request", "focus"),
        nonce,
        command: "focus".into(),
    }
}

fn encoded(value: &impl Serialize) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}

#[test]
fn matching_instance_reports_starting_then_focuses_exactly_once() {
    let dir = TestDir::new();
    let instance = dir.instance("standard", "127.0.0.1", 7635);
    let (owner, calls) = publish(&instance);
    assert_eq!(instance.focus_existing().unwrap(), FocusOutcome::Starting);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    owner.ready();
    assert_eq!(instance.focus_existing().unwrap(), FocusOutcome::Focused);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(instance.try_claim().unwrap().is_none());
}

#[test]
fn service_ports_zero_and_maximum_and_ipv6_do_not_choose_handshake_ports() {
    let dir = TestDir::new();
    for port in [0, u16::MAX] {
        let instance = dir.instance("full", "::1", port);
        let (owner, calls) = publish(&instance);
        owner.ready();
        assert_ne!(owner.discovery.port, 0);
        assert_ne!(owner.discovery.port, port);
        let repeated_configuration = dir.instance("full", "0:0:0:0:0:0:0:1", port);
        assert!(repeated_configuration.try_claim().unwrap().is_none());
        assert_eq!(
            repeated_configuration.focus_existing().unwrap(),
            FocusOutcome::Focused
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn identity_scopes_directory_edition_bind_and_requested_port() {
    let first = TestDir::new();
    let other = TestDir::new();
    let baseline = first.instance("full", "::1", 0);
    let alias = Instance::new(&first.0.join("."), "full", "[0:0:0:0:0:0:0:1]", 0).unwrap();
    assert_eq!(baseline.identity, alias.identity);
    for different in [
        other.instance("full", "::1", 0),
        first.instance("standard", "::1", 0),
        first.instance("full", "127.0.0.1", 0),
        first.instance("full", "::", 0),
        first.instance("full", "::1", 65535),
    ] {
        assert_ne!(baseline.identity, different.identity);
        assert_ne!(baseline.lock_path, different.lock_path);
        assert!(different.try_claim().unwrap().is_some());
    }
    assert_eq!(normalize_bind("LOCALHOST."), "localhost");
}

#[test]
fn adjacent_edition_service_ports_and_foreign_http_listener_coexist() {
    let dir = TestDir::new();
    // Any service listener, including the old adjacent-port collision, is
    // irrelevant to native ownership and never receives a focus probe.
    let foreign = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    foreign.set_nonblocking(true).unwrap();
    let port = foreign.local_addr().unwrap().port();
    let full = dir.instance("full", "127.0.0.1", port.saturating_sub(1));
    let standard = dir.instance("standard", "127.0.0.1", port);
    let (first, first_calls) = publish(&full);
    let (second, second_calls) = publish(&standard);
    first.ready();
    second.ready();
    assert_eq!(full.focus_existing().unwrap(), FocusOutcome::Focused);
    assert_eq!(standard.focus_existing().unwrap(), FocusOutcome::Focused);
    assert_eq!(first_calls.load(Ordering::SeqCst), 1);
    assert_eq!(second_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        foreign.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

// Exercise actual TCP client parsing against a foreign listener. The endpoint
// receives a challenge proof, never the discovery secret or service token.
fn foreign_response(response: impl FnOnce(Request, &Discovery) -> Vec<u8> + Send + 'static) {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 7634);
    let owner = instance.try_claim().unwrap().unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut doc = owner.discovery.clone();
    doc.port = listener.local_addr().unwrap().port();
    let server_doc = doc.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request: Request = read_frame(&mut stream).unwrap();
        assert!(!String::from_utf8(encoded(&request))
            .unwrap()
            .contains(&server_doc.secret));
        let _ = stream.write_all(&response(request, &server_doc));
    });
    assert!(focus(&doc, &instance.identity).is_err());
    server.join().unwrap();
}

#[test]
fn foreign_http_malformed_empty_and_oversized_responses_never_report_focus() {
    for bytes in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec(),
        b"ok\n".to_vec(),
        Vec::new(),
        b"{}\n".to_vec(),
        vec![b'x'; MAX_FRAME + 1],
    ] {
        foreign_response(move |_, _| bytes);
    }
}

#[test]
fn response_must_authenticate_the_protocol_instance_nonce_identity_and_status() {
    for mutation in 0..6 {
        foreign_response(move |request, doc| {
            let mut response = Response {
                protocol: PROTOCOL.into(),
                identity: doc.identity.clone(),
                instance: doc.instance.clone(),
                nonce: request.nonce.clone(),
                status: Status::Focused,
                proof: signature(doc, &request.nonce, "response", "focused"),
            };
            match mutation {
                0 => response.protocol = "HTTP/1.1".into(),
                1 => response.identity = "other-data-directory".into(),
                2 => response.instance = uuid::Uuid::new_v4().to_string(),
                3 => response.nonce = uuid::Uuid::new_v4().to_string(),
                4 => response.proof = request.proof, // a reflected proof is not a response
                5 => response.status = Status::Starting, // authenticated status cannot be changed
                _ => unreachable!(),
            }
            encoded(&response)
        });
    }
}

#[test]
fn invalid_or_empty_requests_never_focus_the_window() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 0);
    let (owner, calls) = publish(&instance);
    owner.ready();
    let mut inputs = vec![
        Vec::new(),
        b"focus\n".to_vec(),
        b"{}\n".to_vec(),
        vec![b'x'; MAX_FRAME + 1],
    ];
    for mutation in 0..7 {
        let mut request = valid_request(&owner.discovery);
        match mutation {
            0 => request.protocol = "wrong/1".into(),
            1 => request.identity = "wrong-directory".into(),
            2 => request.instance = uuid::Uuid::new_v4().to_string(),
            3 => request.nonce = "bad-nonce".into(),
            4 => request.command = "quit".into(),
            5 => request.proof = "0".repeat(64),
            6 => request.proof = signature(&owner.discovery, &request.nonce, "response", "focus"),
            _ => unreachable!(),
        }
        inputs.push(encoded(&request));
    }
    let mut extra = serde_json::to_value(valid_request(&owner.discovery)).unwrap();
    extra["extra"] = serde_json::json!("unrecognized");
    inputs.push(encoded(&extra));
    for input in inputs {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, owner.discovery.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(&input).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        assert!(response.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    assert_eq!(instance.focus_existing().unwrap(), FocusOutcome::Focused);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn stale_discovery_is_retired_only_by_the_lock_owner() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "::1", 0);
    std::fs::write(&instance.discovery, b"stale or malformed metadata").unwrap();
    let mut owner = instance.try_claim().unwrap().unwrap();
    assert!(!instance.discovery.exists());
    owner.publish(|| true).unwrap();
    let published = std::fs::read(&instance.discovery).unwrap();
    assert!(instance.try_claim().unwrap().is_none());
    assert_eq!(std::fs::read(&instance.discovery).unwrap(), published);
    drop(owner);
    assert!(!instance.discovery.exists());
    assert!(
        instance.lock_path.exists(),
        "lock file must never be unlinked"
    );
    assert!(instance.try_claim().unwrap().is_some());
}

#[test]
fn dropping_old_owner_does_not_remove_a_replaced_document() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 0);
    let (owner, _) = publish(&instance);
    let mut replacement = owner.discovery.clone();
    replacement.instance = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        &instance.discovery,
        serde_json::to_vec(&replacement).unwrap(),
    )
    .unwrap();
    drop(owner);
    assert_eq!(
        read_document::<Discovery>(&instance.discovery)
            .unwrap()
            .instance,
        replacement.instance
    );
    // The next real lock owner is allowed to retire that stale replacement.
    let _next = instance.try_claim().unwrap().unwrap();
    assert!(!instance.discovery.exists());
}

#[test]
fn simultaneous_claims_have_exactly_one_bootstrap_owner() {
    let dir = TestDir::new();
    let start = Arc::new(Barrier::new(8));
    let finish = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let path = dir.0.clone();
            let start = start.clone();
            let finish = finish.clone();
            std::thread::spawn(move || {
                let instance = Instance::new(&path, "full", "::1", 0).unwrap();
                start.wait();
                let owner = instance.try_claim().unwrap();
                let won = owner.is_some();
                finish.wait(); // the winner keeps the OS lock until every claim finishes
                drop(owner);
                won
            })
        })
        .collect();
    let winners = workers
        .into_iter()
        .map(|worker| usize::from(worker.join().unwrap()))
        .sum::<usize>();
    assert_eq!(winners, 1);
    assert!(dir
        .instance("full", "::1", 0)
        .try_claim()
        .unwrap()
        .is_some());
}

#[test]
fn listener_cleanup_is_bounded_even_with_a_silent_client() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 0);
    let (owner, calls) = publish(&instance);
    let port = owner.discovery.port;
    let _silent_client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    std::thread::sleep(Duration::from_millis(40));
    let start = Instant::now();
    drop(owner);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!instance.discovery.exists());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    assert!(instance.try_claim().unwrap().is_some());
}

#[test]
fn unavailable_window_and_wrong_discovery_identity_are_not_success() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 0);
    let mut owner = instance.try_claim().unwrap().unwrap();
    owner.publish(|| false).unwrap();
    owner.ready();
    assert!(focus(&owner.discovery, &instance.identity).is_err());
    assert!(focus(&owner.discovery, "foreign-identity").is_err());
}

#[test]
fn silent_foreign_endpoint_has_a_bounded_response_deadline() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "::1", 0);
    let owner = instance.try_claim().unwrap().unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut doc = owner.discovery.clone();
    doc.port = listener.local_addr().unwrap().port();
    let (stop, stopped) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        let _ = stopped.recv_timeout(Duration::from_secs(2));
    });
    let start = Instant::now();
    assert!(focus(&doc, &instance.identity).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    let _ = stop.send(());
    server.join().unwrap();
}

#[test]
fn locked_instance_without_publication_reports_bounded_startup_failure() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "127.0.0.1", 0);
    let _owner = instance.try_claim().unwrap().unwrap();
    assert!(instance.try_claim().unwrap().is_none());
    let start = Instant::now();
    assert!(instance.focus_existing().is_err());
    assert!(start.elapsed() < DISCOVERY_WAIT + Duration::from_secs(1));
    assert!(!instance.discovery.exists());
}

#[test]
fn authenticated_request_can_arrive_in_separate_tcp_fragments() {
    let dir = TestDir::new();
    let instance = dir.instance("full", "::1", 0);
    let (owner, calls) = publish(&instance);
    owner.ready();
    let request = valid_request(&owner.discovery);
    let bytes = encoded(&request);
    let split = bytes.len() / 2;
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, owner.discovery.port)).unwrap();
    stream.write_all(&bytes[..split]).unwrap();
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    stream.write_all(&bytes[split..]).unwrap();
    let response: Response = read_frame(&mut stream).unwrap();
    assert!(response.status == Status::Focused);
    verify(
        &owner.discovery,
        &request.nonce,
        "response",
        "focused",
        &response.proof,
    )
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
