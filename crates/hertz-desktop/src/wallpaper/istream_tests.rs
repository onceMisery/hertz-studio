// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! COM IStream 往返测试（§8.1/C59）：Read 有界、Seek 三原点、Stat 尺寸、
//! Clone 独立游标、Write 拒绝、槽随流生命周期归还。

use super::super::istream::MediaIStream;
use super::super::media_stream::StreamSlotPool;
use crate::wallpaper::library::tempfileish;
use windows::Win32::System::Com::{
    IStream, STATFLAG_NONAME, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
pub(crate) struct HeldFixture {
    pub(crate) assets: super::super::assets::AssetStore,
    pub(crate) _dir: tempfileish::TempDir,
    pub(crate) access: super::super::access::MediaAccess,
    pub(crate) pool: std::sync::Arc<StreamSlotPool>,
    pub(crate) gate: std::sync::Arc<super::read_probe::ReadGate>,
    pub(crate) stream: IStream,
    pub(crate) hash: String,
    pub(crate) path: std::path::PathBuf,
    pub(crate) entry: hertz_wallpaper::VerifiedEntry,
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
pub(crate) fn held_font_fixture(tag: &str, hold: std::time::Duration) -> HeldFixture {
    // This helper installs the licensed HWPK via snapshot_input, validate_staged,
    // unpack_projection and publish_staging; only AssetStore returns the true pin.
    let (assets, dir, reference, entry) = super::super::font_prepare::installed(tag);
    let pin = std::sync::Arc::new(
        assets
            .pin_verified_media(&reference.package_hash, "assets/instrument-serif.ttf")
            .unwrap()
            .unwrap(),
    );
    assert_eq!(pin.entry.bytes, 8336);
    assert_eq!(
        pin.entry.sha256,
        "52e207c6d3cd36d1880050598c4c31f16848575b5f419fd9a78ed486c16acbaf"
    );
    let access = super::super::access::MediaAccess::new();
    assert!(access.grant_pinned(
        7,
        reference.package_hash.clone(),
        std::sync::Arc::clone(&pin)
    ));
    let gate = super::read_probe::ReadGate::with_test_deadlines(
        super::read_probe::ReadOwner {
            probe_id: 7,
            generation: 7,
            session: "probe-7".into(),
            package_hash: reference.package_hash.clone(),
            entry_path: pin.entry.path.clone(),
            content_sha256: pin.entry.sha256.clone(),
            content_bytes: pin.entry.bytes,
        },
        hold,
        std::time::Duration::from_secs(4),
    );
    assert!(access.arm_file_read_probe_for_test(
        7,
        &reference.package_hash,
        &pin.entry.path,
        std::sync::Arc::clone(&gate)
    ));
    let mut permit = access
        .permit(&reference.package_hash, &pin.entry.path)
        .unwrap();
    permit.bind_response_for_test(19, 12);
    let response = permit.native_response_for_test().unwrap();
    let pool = StreamSlotPool::new();
    let file = super::super::media_stream::MediaFileStream::open(&pin.path, &pool).unwrap();
    let stream = MediaIStream::from_file_with_permit(
        file,
        pin.path.clone(),
        &pool,
        (0, pin.entry.bytes),
        Some(permit),
    )
    .unwrap();
    gate.response_assigned(&response, true);
    HeldFixture {
        assets,
        _dir: dir,
        access,
        pool,
        gate,
        stream,
        hash: reference.package_hash,
        path: pin.path.clone(),
        entry,
    }
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
pub(crate) fn wait_held(
    gate: &super::read_probe::ReadGate,
) -> super::read_probe::ReadProbeSnapshot {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let snapshot = gate.snapshot();
        if snapshot.read_in_flight {
            return snapshot;
        }
        assert!(
            std::time::Instant::now() < until,
            "real COM Read did not enter: {}",
            snapshot.phase
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
pub(crate) fn read_worker(
    stream: IStream,
) -> std::thread::JoinHandle<(windows::core::HRESULT, u32, [u8; 8])> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
    }
    let reference = windows::core::AgileReference::new(&stream).unwrap();
    unsafe {
        CoUninitialize();
    }
    std::thread::spawn(move || {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let stream = reference.resolve().unwrap();
        let mut bytes = [0; 8];
        let mut count = 0;
        let result = unsafe { stream.Read(bytes.as_mut_ptr().cast(), 8, Some(&mut count)) };
        drop(stream);
        unsafe {
            CoUninitialize();
        }
        (result, count, bytes)
    })
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_real_pin_read_keeps_original_slot_permit_until_reaper_after_revoke() {
    use super::read_probe::ReleaseReason;
    use windows::Win32::Foundation::STG_E_ACCESSDENIED;
    let fixture = held_font_fixture("istream-held-revoke", std::time::Duration::from_secs(2));
    let thread = read_worker(fixture.stream.clone());
    let snapshot = wait_held(&fixture.gate);
    assert_eq!(snapshot.phase, "held");
    assert_eq!(snapshot.physical_read_bytes, 8);
    assert_eq!(snapshot.on_ui_thread, Some(false));
    assert!(snapshot.file_held && snapshot.stream_slot_held && snapshot.read_permit_held);
    assert_eq!(fixture.access.debug_scope_snapshot(7), Some((true, 1)));
    let drain = fixture.access.revoke();
    let before = std::time::Instant::now();
    super::reap_revoked_streams();
    assert!(before.elapsed() < std::time::Duration::from_millis(500));
    assert_eq!(fixture.pool.active(), 1);
    assert!(!drain.is_drained());
    assert!(!thread.is_finished());
    assert_eq!(fixture.access.debug_scope_snapshot(7), Some((false, 1)));
    fixture.gate.release(ReleaseReason::Explicit);
    let (result, count, _) = thread.join().unwrap();
    assert_eq!(result, STG_E_ACCESSDENIED);
    assert_eq!(count, 0);
    assert!(!fixture.gate.snapshot().read_in_flight);
    assert!(
        !drain.is_drained(),
        "Read epilogue must not finish the original Drain"
    );
    super::reap_revoked_streams();
    assert!(drain.is_drained());
    assert_eq!(fixture.pool.active(), 0);
    let snapshot = fixture.gate.snapshot();
    assert_eq!(snapshot.phase, "reclaimed");
    assert!(snapshot.resources_reclaimed);
    assert!(!snapshot.file_held && !snapshot.stream_slot_held && !snapshot.read_permit_held);
    let mut bytes = [0; 8];
    unsafe {
        assert_eq!(
            fixture.stream.Read(bytes.as_mut_ptr().cast(), 8, None),
            STG_E_ACCESSDENIED
        );
        assert!(fixture.stream.Clone().is_err());
    }
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_new_generation_cannot_restore_old_real_reader() {
    let fixture = held_font_fixture("istream-held-replace", std::time::Duration::from_secs(2));
    let thread = read_worker(fixture.stream.clone());
    wait_held(&fixture.gate);
    let drain = fixture.access.revoke();
    let pin = std::sync::Arc::new(
        fixture
            .assets
            .pin_verified_media(&fixture.hash, &fixture.entry.path)
            .unwrap()
            .unwrap(),
    );
    assert!(fixture.access.grant_pinned(8, fixture.hash.clone(), pin));
    let next = fixture
        .access
        .permit(&fixture.hash, &fixture.entry.path)
        .unwrap();
    assert!(next.read_gate_for_test().is_none());
    let file =
        super::super::media_stream::MediaFileStream::open(&fixture.path, &fixture.pool).unwrap();
    let next_stream = MediaIStream::from_file_with_permit(
        file,
        fixture.path.clone(),
        &fixture.pool,
        (0, fixture.entry.bytes),
        Some(next),
    )
    .unwrap();
    assert_eq!(
        read_worker(next_stream.clone()).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    fixture
        .gate
        .release(super::read_probe::ReleaseReason::Explicit);
    assert_eq!(
        thread.join().unwrap().0,
        windows::Win32::Foundation::STG_E_ACCESSDENIED
    );
    super::reap_revoked_streams();
    assert!(drain.is_drained());
    assert_eq!(fixture.access.debug_scope_snapshot(8), Some((true, 1)));
    assert_eq!(
        read_worker(next_stream).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_natural_com_clone_claims_once_and_reaper_skips_only_busy_stream() {
    let fixture = held_font_fixture("istream-held-clone", std::time::Duration::from_secs(2));
    let clone = unsafe { fixture.stream.Clone().unwrap() };
    assert_eq!(fixture.access.debug_scope_snapshot(7), Some((true, 2)));
    assert_eq!(fixture.pool.active(), 2);
    let thread = read_worker(clone.clone());
    let snapshot = wait_held(&fixture.gate);
    assert!(snapshot.parent_stream_id.is_some());
    assert_ne!(snapshot.parent_stream_id, snapshot.stream_id);
    let (result, count, bytes) = read_worker(fixture.stream.clone()).join().unwrap();
    assert_eq!(result, windows::Win32::Foundation::S_OK);
    assert_eq!(count, 8);
    assert_eq!(fixture.gate.snapshot().stream_id, snapshot.stream_id);
    let drain = fixture.access.revoke();
    super::reap_revoked_streams();
    assert_eq!(
        fixture.pool.active(),
        1,
        "independent revoked stream is reaped while clone Read is held"
    );
    assert_eq!(fixture.access.debug_scope_snapshot(7), Some((false, 1)));
    fixture
        .gate
        .release(super::read_probe::ReleaseReason::Explicit);
    let (result, _, clone_bytes) = thread.join().unwrap();
    assert_eq!(result, windows::Win32::Foundation::STG_E_ACCESSDENIED);
    assert_eq!(bytes, clone_bytes);
    super::reap_revoked_streams();
    assert!(drain.is_drained());
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_deadline_spurious_wake_host_drop_and_poison_are_bounded() {
    for reason in ["deadline", "host-drop", "poison"] {
        let fixture = held_font_fixture(
            &format!("istream-held-{reason}"),
            std::time::Duration::from_millis(100),
        );
        let thread = read_worker(fixture.stream.clone());
        wait_held(&fixture.gate);
        fixture.gate.wake_for_test();
        assert!(!thread.is_finished());
        match reason {
            "host-drop" => drop(super::read_probe::HostDropGuard(Some(fixture.gate.clone()))),
            "poison" => {
                let gate = fixture.gate.clone();
                assert!(std::thread::spawn(move || gate.poison_for_test())
                    .join()
                    .is_err());
                fixture.gate.snapshot();
            }
            _ => {}
        }
        let (result, count, _) = thread.join().unwrap();
        assert_eq!(result, windows::Win32::Foundation::S_OK);
        assert_eq!(count, 8);
        let snapshot = fixture.gate.snapshot();
        assert!(!snapshot.read_in_flight);
        assert!(snapshot.hold_elapsed_ms < 1000);
        let expected = match reason {
            "host-drop" => "HostDrop",
            "poison" => "InternalFailure",
            _ => "Deadline",
        };
        assert_eq!(
            serde_json::to_value(snapshot.release_reason).unwrap(),
            expected
        );
        if reason == "poison" {
            assert_eq!(snapshot.phase, "failed");
        }
    }
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_ui_read_skips_wait_and_ui_concurrent_calls_never_wait_for_held_lock() {
    let fixture = held_font_fixture("istream-held-ui", std::time::Duration::from_secs(2));
    let mut bytes = [0; 8];
    assert_eq!(
        unsafe { fixture.stream.Read(bytes.as_mut_ptr().cast(), 0, None) },
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(fixture.gate.snapshot().phase, "armed");
    assert_eq!(
        unsafe { fixture.stream.Read(bytes.as_mut_ptr().cast(), 8, None) },
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(fixture.gate.snapshot().phase, "skipped");
    assert_eq!(fixture.gate.snapshot().ui_thread_read_skipped, 1);
    assert!(!fixture.gate.snapshot().read_in_flight);
    let fixture = held_font_fixture("istream-held-ui-busy", std::time::Duration::from_secs(2));
    let thread = read_worker(fixture.stream.clone());
    wait_held(&fixture.gate);
    let before = std::time::Instant::now();
    unsafe {
        assert_eq!(
            fixture.stream.Read(bytes.as_mut_ptr().cast(), 8, None),
            windows::Win32::Foundation::STG_E_INUSE
        );
        assert_eq!(
            fixture
                .stream
                .Seek(0, STREAM_SEEK_SET, None)
                .unwrap_err()
                .code(),
            windows::Win32::Foundation::STG_E_INUSE
        );
        assert_eq!(
            fixture.stream.Clone().unwrap_err().code(),
            windows::Win32::Foundation::STG_E_INUSE
        );
    }
    assert!(before.elapsed() < std::time::Duration::from_millis(500));
    assert_eq!(fixture.gate.snapshot().ui_concurrent_stream_call_skipped, 3);
    assert!(
        fixture.gate.snapshot().read_in_flight,
        "another rejected COM call is not the held Read exit"
    );
    fixture
        .gate
        .release(super::read_probe::ReleaseReason::Explicit);
    let _ = thread.join().unwrap();
    assert_eq!(fixture.gate.snapshot().phase, "skipped");
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_requires_real_exact_pin_nonempty_response_and_original_assignment() {
    use super::super::{access::MediaAccess, media_stream::MediaFileStream};
    use super::read_probe::{ReadGate, ReleaseReason};
    let fixture = held_font_fixture("istream-held-exact", std::time::Duration::from_secs(2));
    let pin = std::sync::Arc::new(
        fixture
            .assets
            .pin_verified_media(&fixture.hash, &fixture.entry.path)
            .unwrap()
            .unwrap(),
    );
    let new_gate = |generation, mutator: fn(&mut super::read_probe::ReadOwner)| {
        let mut owner = fixture.gate.owner.clone();
        owner.generation = generation;
        mutator(&mut owner);
        ReadGate::new(owner, 500, std::thread::current().id()).unwrap()
    };
    let access = MediaAccess::new();
    assert!(access.replace(7, &[(fixture.hash.clone(), fixture.entry.path.clone())]));
    assert!(
        !access.arm_file_read_probe_for_test(
            7,
            &fixture.hash,
            &fixture.entry.path,
            new_gate(7, |_| {})
        ),
        "a string resource has no true pin"
    );
    assert!(access.grant_pinned(8, fixture.hash.clone(), pin.clone()));
    for (generation, hash, path, mutator) in [
        (
            7,
            fixture.hash.clone(),
            fixture.entry.path.clone(),
            (|_: &mut super::read_probe::ReadOwner| {}) as fn(&mut super::read_probe::ReadOwner),
        ),
        (8, "a".repeat(64), fixture.entry.path.clone(), |owner| {
            owner.package_hash = "a".repeat(64)
        }),
        (
            8,
            fixture.hash.clone(),
            "assets/other.ttf".into(),
            |owner| owner.entry_path = "assets/other.ttf".into(),
        ),
        (
            8,
            fixture.hash.clone(),
            fixture.entry.path.clone(),
            |owner| owner.content_sha256 = "a".repeat(64),
        ),
        (
            8,
            fixture.hash.clone(),
            fixture.entry.path.clone(),
            |owner| owner.content_bytes += 1,
        ),
    ] {
        assert!(!access.arm_file_read_probe_for_test(
            generation,
            &hash,
            &path,
            new_gate(generation, mutator)
        ));
    }
    let gate = new_gate(8, |_| {});
    assert!(access.arm_file_read_probe_for_test(
        8,
        &fixture.hash,
        &fixture.entry.path,
        gate.clone()
    ));
    assert!(
        !access.arm_file_read_probe_for_test(8, &fixture.hash, &fixture.entry.path, gate.clone()),
        "arm only once after original grant"
    );
    // No native response identity: an actual physical COM Read still cannot claim.
    let permit = access.permit(&fixture.hash, &fixture.entry.path).unwrap();
    let file = MediaFileStream::open(&fixture.path, &fixture.pool).unwrap();
    let unbound = MediaIStream::from_file_with_permit(
        file,
        fixture.path.clone(),
        &fixture.pool,
        (0, fixture.entry.bytes),
        Some(permit),
    )
    .unwrap();
    assert_eq!(
        read_worker(unbound.clone()).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(gate.snapshot().phase, "armed");
    // A successful-response marker cannot attach the gate to a wrong actual file.
    let (_other_dir, other_path, other_bytes) = self::fixture("istream-held-other-file");
    let mut permit = access.permit(&fixture.hash, &fixture.entry.path).unwrap();
    permit.bind_response_for_test(31, 21);
    let response = permit.native_response_for_test().unwrap();
    let wrong_file = MediaIStream::from_file_with_permit(
        MediaFileStream::open(&other_path, &fixture.pool).unwrap(),
        other_path.clone(),
        &fixture.pool,
        (0, other_bytes.len() as u64),
        Some(permit),
    )
    .unwrap();
    gate.response_assigned(&response, true);
    assert_eq!(
        read_worker(wrong_file).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(gate.snapshot().physical_read_bytes, 0);
    std::fs::write(&other_path, vec![42; fixture.entry.bytes as usize]).unwrap();
    let mut permit = access.permit(&fixture.hash, &fixture.entry.path).unwrap();
    permit.bind_response_for_test(31, 21);
    let impersonated_response = permit.native_response_for_test().unwrap();
    let impersonated = MediaIStream::from_file_with_permit(
        MediaFileStream::open(&other_path, &fixture.pool).unwrap(),
        fixture.path.clone(),
        &fixture.pool,
        (0, fixture.entry.bytes),
        Some(permit),
    )
    .unwrap();
    gate.response_assigned(&impersonated_response, true);
    assert_eq!(
        read_worker(impersonated).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(
        gate.snapshot().physical_read_bytes,
        0,
        "same-length other file cannot impersonate the pin via caller path"
    );
    // HEAD/empty body and cb=0 cannot become a physical held Read.
    let mut permit = access.permit(&fixture.hash, &fixture.entry.path).unwrap();
    permit.bind_response_for_test(31, 21);
    let empty = MediaIStream::from_file_with_permit(
        MediaFileStream::open(&fixture.path, &fixture.pool).unwrap(),
        fixture.path.clone(),
        &fixture.pool,
        (0, 0),
        Some(permit),
    )
    .unwrap();
    assert_eq!(read_worker(empty).join().unwrap().1, 0);
    assert_eq!(gate.snapshot().physical_read_bytes, 0);
    gate.response_assigned(&response, false);
    let mut permit = access.permit(&fixture.hash, &fixture.entry.path).unwrap();
    permit.bind_response_for_test(31, 21);
    let rejected = MediaIStream::from_file_with_permit(
        MediaFileStream::open(&fixture.path, &fixture.pool).unwrap(),
        fixture.path.clone(),
        &fixture.pool,
        (0, fixture.entry.bytes),
        Some(permit),
    )
    .unwrap();
    assert_eq!(
        read_worker(rejected).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(gate.snapshot().phase, "failed");
    assert!(!gate.snapshot().read_in_flight);
    let payload_access = MediaAccess::new();
    let payload_key = (fixture.hash.clone(), "session/probe/8.json".into());
    let payload: std::sync::Arc<[u8]> = vec![42; 16].into();
    let grant = payload_access
        .grant_composition(8, vec![], payload_key.clone(), payload.clone())
        .unwrap();
    let mut owner = fixture.gate.owner.clone();
    owner.generation = 8;
    owner.entry_path = payload_key.1.clone();
    assert!(!payload_access.arm_file_read_probe_for_test(
        8,
        &fixture.hash,
        &payload_key.1,
        ReadGate::new(owner, 500, std::thread::current().id()).unwrap()
    ));
    let payload_stream = MediaIStream::from_payload(
        payload,
        payload_access
            .permit(&fixture.hash, &payload_key.1)
            .unwrap(),
        &fixture.pool,
    )
    .unwrap();
    assert_eq!(
        read_worker(payload_stream).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    drop(grant);
    fixture.gate.release(ReleaseReason::HostDrop);
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn held_istream_first_real_reader_selects_exact_response_among_multiple_original_responses() {
    let fixture = held_font_fixture("istream-held-responses", std::time::Duration::from_secs(2));
    let make_response = |request_id| {
        let mut permit = fixture
            .access
            .permit(&fixture.hash, &fixture.entry.path)
            .unwrap();
        permit.bind_response_for_test(request_id, 12);
        let response = permit.native_response_for_test().unwrap();
        let file = super::super::media_stream::MediaFileStream::open(&fixture.path, &fixture.pool)
            .unwrap();
        let stream = MediaIStream::from_file_with_permit(
            file,
            fixture.path.clone(),
            &fixture.pool,
            (0, fixture.entry.bytes),
            Some(permit),
        )
        .unwrap();
        (stream, response)
    };
    let (second, response) = make_response(20);
    // Its original SetResponse has not succeeded: another response's success
    // never qualifies this physical reader for the diagnostic hold.
    assert_eq!(
        read_worker(second.clone()).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    assert_eq!(fixture.gate.snapshot().phase, "armed");
    fixture.gate.response_assigned(&response, true);
    let thread = read_worker(fixture.stream.clone());
    let snapshot = wait_held(&fixture.gate);
    assert_eq!(
        snapshot.native_request_id,
        Some(19),
        "first physical claimed reader selects its own response identity"
    );
    assert_eq!(
        read_worker(second.clone()).join().unwrap().0,
        windows::Win32::Foundation::S_OK
    );
    let (third, third_response) = make_response(21);
    fixture.gate.response_assigned(&third_response, true);
    assert_eq!(fixture.gate.snapshot().native_request_id, Some(19));
    assert_eq!(fixture.gate.snapshot().phase, "held");
    assert_eq!(fixture.access.debug_scope_snapshot(7), Some((true, 3)));
    fixture
        .gate
        .release(super::read_probe::ReleaseReason::Explicit);
    assert_eq!(thread.join().unwrap().0, windows::Win32::Foundation::S_OK);
    drop(second);
    drop(third);
}

#[test]
fn composition_payload_uses_original_pool_seek_clone_and_revoke_barrier() {
    use super::super::access::MediaAccess;
    use windows::Win32::Foundation::{STG_E_ACCESSDENIED, S_OK};
    let access = MediaAccess::new();
    let hash = "a".repeat(64);
    let key = (hash.clone(), "session/abcd/4.json".to_owned());
    let payload: std::sync::Arc<[u8]> = vec![23; 1024 * 1024 + 17].into();
    let grant = access
        .grant_composition(4, vec![], key.clone(), payload.clone())
        .unwrap();
    let pool = StreamSlotPool::new();
    let permit = access.permit(&key.0, &key.1).unwrap();
    let stream = MediaIStream::from_payload(payload, permit, &pool).unwrap();
    let mut out = [0u8; 20];
    let mut count = 0;
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 20, Some(&mut count)),
            S_OK
        );
        assert_eq!(count, 20);
    }
    let clone = unsafe { stream.Clone().unwrap() };
    assert_eq!(pool.active(), 2);
    unsafe {
        clone.Seek(3, STREAM_SEEK_SET, None).unwrap();
        stream.Seek(20, STREAM_SEEK_SET, None).unwrap();
        assert_eq!(clone.Write(std::ptr::null(), 0, None), STG_E_ACCESSDENIED);
    }
    let drain = grant.revoke();
    assert!(!drain.is_drained());
    super::reap_revoked_streams();
    assert!(drain.is_drained());
    assert_eq!(pool.active(), 0);
    unsafe {
        assert_eq!(
            clone.Read(out.as_mut_ptr().cast(), 20, None),
            STG_E_ACCESSDENIED
        );
        assert!(stream.Clone().is_err());
    }
    assert!(access.permit(&hash, "session/abcd/4.json").is_none());
}

#[test]
fn revocation_closes_files_and_clones_even_when_com_references_survive() {
    use super::super::access::MediaAccess;
    use super::super::media_stream::MediaFileStream;
    use windows::Win32::Foundation::STG_E_ACCESSDENIED;
    let (_dir, path, body) = fixture("istream-revocation");
    let pool = StreamSlotPool::new();
    let access = MediaAccess::new();
    let hash = "a".repeat(64);
    assert!(access.replace(1, &[(hash.clone(), "assets/media.bin".into())]));
    let file = MediaFileStream::open(&path, &pool).unwrap();
    let stream = MediaIStream::from_file_with_permit(
        file,
        path.clone(),
        &pool,
        (0, body.len() as u64),
        access.permit(&hash, "assets/media.bin"),
    )
    .unwrap();
    let clone = unsafe { stream.Clone().unwrap() };
    assert_eq!(pool.active(), 2);
    let drain = access.revoke();
    assert!(!drain.is_drained(), "撤销不等于文件已经关闭");
    super::reap_revoked_streams();
    assert!(drain.is_drained(), "COM 外壳不能持有文件活动屏障");
    assert_eq!(pool.active(), 0, "撤销不得等待浏览器释放 COM 引用");
    let mut out = [0u8; 8];
    let mut count = 7;
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 8, Some(&mut count)),
            STG_E_ACCESSDENIED
        );
        assert_eq!(count, 0);
        assert!(stream.Seek(0, STREAM_SEEK_SET, None).is_err());
        assert!(stream.Clone().is_err());
        assert_eq!(
            clone.Read(out.as_mut_ptr().cast(), 8, None),
            STG_E_ACCESSDENIED
        );
    }
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_ok());
    assert!(access.replace(2, &[(hash.clone(), "assets/media.bin".into())]));
    // 新代际的授权不能复活旧流。
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 8, None),
            STG_E_ACCESSDENIED
        );
    }
}

#[test]
fn com_read_honors_optional_count_and_fills_large_requests_until_real_eof() {
    use windows::Win32::Foundation::{S_FALSE, S_OK};
    let (dir, path, _) = fixture("istream-read-contract");
    let bytes = vec![19u8; 2 * super::super::media_stream::MAX_READ_BYTES + 17];
    std::fs::write(&path, &bytes).unwrap();
    let pool = StreamSlotPool::new();
    let stream = MediaIStream::open(&path, &pool, (0, bytes.len() as u64)).unwrap();
    let mut out = vec![0; bytes.len()];
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), out.len() as u32, None),
            S_OK
        );
        assert_eq!(out, bytes);
        let mut count = 7;
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 1, Some(&mut count)),
            S_FALSE
        );
        assert_eq!(count, 0);
        assert!(stream.Seek(i64::MAX, STREAM_SEEK_CUR, None).is_err());
        assert_eq!(stream.Read(std::ptr::null_mut(), 0, None), S_OK);
    }
    drop(stream);
    assert!(MediaIStream::open(&path, &pool, (bytes.len() as u64, 1)).is_err());
    assert_eq!(pool.active(), 0);
    drop(dir);
}

fn fixture(tag: &str) -> (tempfileish::TempDir, std::path::PathBuf, Vec<u8>) {
    let dir = tempfileish::temp_dir(tag);
    // 5000 字节可辨识内容。
    let body: Vec<u8> = (0..5000u32).map(|i| ((i * 7) % 253) as u8).collect();
    let path = dir.path().join("media.bin");
    std::fs::write(&path, &body).unwrap();
    (dir, path, body)
}

#[test]
fn com_stream_reads_seeks_and_stats() {
    let (_dir, path, body) = fixture("istream-basic");
    let pool = StreamSlotPool::new();
    assert_eq!(pool.active(), 0);
    // 200 响应：窗口是整个文件（base=0, len=文件长度）。
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    assert_eq!(pool.active(), 1, "打开即占用一个流槽");

    unsafe {
        // Read 16 字节。
        let mut buffer = [0u8; 16];
        let mut read = 0u32;
        stream
            .Read(
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                Some(&mut read),
            )
            .ok()
            .unwrap();
        assert_eq!(read, 16);
        assert_eq!(&buffer, &body[..16]);

        // Seek SET → 读中段。
        let mut position = 0u64;
        stream
            .Seek(100, STREAM_SEEK_SET, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 100);
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer[..8], &body[100..108]);
        assert_eq!(position, 100);

        // Seek CUR 相对推进。
        stream
            .Seek(2, STREAM_SEEK_CUR, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 110);

        // Seek END -8 → 尾部。
        stream
            .Seek(-8, STREAM_SEEK_END, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 4992);
        stream
            .Read(buffer.as_mut_ptr().cast(), 16, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8, "EOF 只在真实读到末尾出现（不返回伪 EOF）");
        assert_eq!(&buffer[..8], &body[4992..5000]);
        // 再读 → 0 且 S_OK。
        stream
            .Read(buffer.as_mut_ptr().cast(), 16, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 0);

        // Stat：类型 STREAM + cbSize。
        let mut stat = Default::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok().unwrap();
        assert_eq!(stat.cbSize, 5000);
        assert_eq!(stat.r#type, 2 /* STGTY_STREAM */);

        // 负位移与非法原点拒绝。
        assert!(stream.Seek(-1, STREAM_SEEK_SET, None).is_err());
    }
}

#[test]
fn com_clone_has_independent_cursor() {
    let (_dir, path, body) = fixture("istream-clone");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    unsafe {
        stream.Seek(1000, STREAM_SEEK_SET, None).ok().unwrap();
        let clone = stream.Clone().unwrap();
        // 克隆对齐位置；各自 Read 不互相移动游标（独立句柄）。
        let mut buffer_a = [0u8; 8];
        let mut buffer_b = [0u8; 8];
        let mut read = 0u32;
        stream
            .Read(buffer_a.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        clone
            .Read(buffer_b.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer_a, &body[1000..1008]);
        assert_eq!(&buffer_b, &body[1000..1008]);
        // 原流推进后克隆仍停在 1000。
        stream.Seek(2000, STREAM_SEEK_SET, None).ok().unwrap();
        clone
            .Read(buffer_b.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer_b, &body[1008..1016]);
    }
    // 两个流（含克隆）各占一槽；全部释放后归零。
    drop(stream);
    assert_eq!(pool.active(), 0, "C59：句柄生命周期决定槽回收");
}

#[test]
fn com_write_is_denied_and_agile_marker_present() {
    let (_dir, path, body) = fixture("istream-write");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    unsafe {
        let mut written = 0u32;
        let hr = stream.Write("no".as_ptr().cast(), 2, Some(&mut written));
        assert!(hr.is_err(), "只读流的 Write 必须拒绝");
    }
}

/// 206 语义（§8.1）：流的内容是 body 窗口，不是整个文件。
/// 浏览器按 body 语义消费——流位置 0 必须就是 `Content-Range` 的 start 字节。
#[test]
fn com_stream_serves_a_range_window() {
    let (_dir, path, body) = fixture("istream-window");
    let pool = StreamSlotPool::new();
    // bytes=1000-1499 → base=1000, len=500。
    let stream: IStream = MediaIStream::open(&path, &pool, (1000, 500)).unwrap();
    unsafe {
        // 位置 0 即 body 首字节：文件偏移 1000，不是文件开头。
        let mut buffer = [0u8; 8];
        let mut read = 0u32;
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer, &body[1000..1008]);

        // Stat 报窗口长度（= Content-Length），不是文件总长。
        let mut stat = Default::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok().unwrap();
        assert_eq!(stat.cbSize, 500);

        // Seek 的三个原点都相对窗口，不是相对文件。
        let mut position = 0u64;
        stream
            .Seek(-8, STREAM_SEEK_END, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 492, "END 相对窗口末端");
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer, &body[1492..1500]);

        // 越过窗口末端 → 越界拒绝；窗口内读到末尾 → 0。
        assert!(stream.Seek(501, STREAM_SEEK_SET, None).is_err());
        stream.Seek(500, STREAM_SEEK_SET, None).ok().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 0);
    }
}

/// 窗口流的 Clone 也要带窗口，且各自游标独立。
#[test]
fn com_clone_keeps_the_window() {
    let (_dir, path, body) = fixture("istream-window-clone");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (2000, 100)).unwrap();
    unsafe {
        let mut buffer = [0u8; 4];
        let mut read = 0u32;
        let clone = stream.Clone().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2000..2004]);
        clone
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2000..2004], "克隆的起点仍是窗口起点");
        // 克隆推进不影响原流。
        clone.Seek(50, STREAM_SEEK_SET, None).ok().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2004..2008]);
    }
}
