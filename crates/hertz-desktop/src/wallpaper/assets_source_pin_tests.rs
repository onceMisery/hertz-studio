// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::library::tempfileish;
use std::{collections::VecDeque, io::ErrorKind, os::windows::fs::OpenOptionsExt};

enum Step {
    Read(usize),
    Interrupted(bool),
    Fail(bool),
    CancelRead(usize),
    CancelEof,
}

struct ScriptedRead<'a> {
    bytes: &'a [u8],
    position: usize,
    steps: VecDeque<Step>,
    requests: Vec<usize>,
    returned: usize,
    cancel: &'a AtomicBool,
}

impl<'a> ScriptedRead<'a> {
    fn new(bytes: &'a [u8], steps: impl IntoIterator<Item = Step>, cancel: &'a AtomicBool) -> Self {
        Self {
            bytes,
            position: 0,
            steps: steps.into_iter().collect(),
            requests: Vec::new(),
            returned: 0,
            cancel,
        }
    }
}

impl Read for ScriptedRead<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.requests.push(buffer.len());
        let step = self.steps.pop_front().unwrap_or(Step::Read(buffer.len()));
        let result = match step {
            Step::Interrupted(cancel) => {
                self.cancel.store(cancel, Ordering::Release);
                Err(std::io::Error::from(ErrorKind::Interrupted))
            }
            Step::Fail(cancel) => {
                self.cancel.store(cancel, Ordering::Release);
                Err(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "source read denied",
                ))
            }
            Step::CancelEof => {
                assert_eq!(self.position, self.bytes.len());
                self.cancel.store(true, Ordering::Release);
                Ok(0)
            }
            Step::Read(limit) | Step::CancelRead(limit) => {
                let count = limit
                    .min(buffer.len())
                    .min(self.bytes.len() - self.position);
                buffer[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
                self.position += count;
                if matches!(step, Step::CancelRead(_)) {
                    self.cancel.store(true, Ordering::Release);
                }
                Ok(count)
            }
        };
        self.returned += 1;
        result
    }
}

#[test]
fn initial_cancellation_does_not_start_a_read() {
    let cancel = AtomicBool::new(true);
    let mut reader = ScriptedRead::new(b"abc", [], &cancel);
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap_err().code,
        "cancelled"
    );
    assert!(reader.requests.is_empty());
    assert_eq!(reader.returned, 0);
}

#[test]
fn cancellation_during_read_waits_for_return_and_does_not_start_the_next_read() {
    let cancel = AtomicBool::new(false);
    let mut reader = ScriptedRead::new(b"abc", [Step::CancelRead(1)], &cancel);
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap_err().code,
        "cancelled"
    );
    assert_eq!(reader.position, 1);
    assert_eq!(reader.returned, 1);
    assert_eq!(reader.requests, [64 * 1024]);
}

#[test]
fn cancellation_on_eof_never_returns_a_successful_digest() {
    let cancel = AtomicBool::new(false);
    let mut reader = ScriptedRead::new(b"abc", [Step::Read(3), Step::CancelEof], &cancel);
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap_err().code,
        "cancelled"
    );
    assert_eq!(reader.returned, 2);
    assert_eq!(reader.requests.len(), 2);
}

#[test]
fn short_reads_and_uncancelled_interrupted_produce_the_complete_known_digest() {
    let cancel = AtomicBool::new(false);
    let mut reader = ScriptedRead::new(
        b"abc",
        [Step::Read(1), Step::Interrupted(false), Step::Read(1)],
        &cancel,
    );
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap(),
        (
            3,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()
        )
    );
    assert_eq!(reader.position, 3);
    assert_eq!(reader.returned, 5);
}

#[test]
fn cancelled_interrupted_does_not_retry() {
    let cancel = AtomicBool::new(false);
    let mut reader = ScriptedRead::new(b"abc", [Step::Interrupted(true)], &cancel);
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap_err().code,
        "cancelled"
    );
    assert_eq!(reader.returned, 1);
    assert_eq!(reader.requests.len(), 1);
}

#[test]
fn source_sha_read_requests_are_bounded_to_64_kib() {
    let cancel = AtomicBool::new(false);
    let bytes = vec![b'a'; 2 * 64 * 1024 + 17];
    let mut reader = ScriptedRead::new(&bytes, [], &cancel);
    assert_eq!(
        read_source_sha256(&mut reader, &cancel).unwrap(),
        (
            131089,
            "c5e33faedb41ecc23507197af1d853212ff36641279638ebc1288c90f417404f".into()
        )
    );
    assert_eq!(reader.requests, [64 * 1024; 4]);
}

#[test]
fn real_read_errors_keep_their_error_even_when_cancelled_during_read() {
    for cancel_during_read in [false, true] {
        let cancel = AtomicBool::new(false);
        let mut reader = ScriptedRead::new(
            b"abc",
            [Step::Read(1), Step::Fail(cancel_during_read)],
            &cancel,
        );
        let error = read_source_sha256(&mut reader, &cancel).unwrap_err();
        assert_eq!(error.code, "io");
        assert_eq!(error.message, "source read denied");
        assert_eq!(reader.returned, 2);
        assert_eq!(reader.requests.len(), 2);
    }
}

const SOURCE: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#ff0000"/></svg>"##;
const JOB: &str = "source-pin";

fn package_bytes() -> Vec<u8> {
    use std::io::Write;
    let document = serde_json::to_vec(&serde_json::json!({
        "documentVersion":1,"canvas":{"width":64,"height":64,"colorSpace":"srgb","background":"#000000"},
        "nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"source"},"properties":{"width":64,"height":64,"anchorX":0,"anchorY":0,"fit":"contain"}}],
        "timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]
    })).unwrap();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "formatVersion":1,"workId":"59dcced2-2d46-49f4-b661-2e48f6e42587","version":1,"title":"Source pin fixture",
        "content":{"kind":"composition","document":"document.json"},
        "assets":[{"id":"source","kind":"vector","source":"assets/source.svg"}],
        "files":[{"path":"document.json","bytes":document.len(),"sha256":format!("{:x}",Sha256::digest(&document)),"mime":"application/json"},
            {"path":"assets/source.svg","bytes":SOURCE.len(),"sha256":format!("{:x}",Sha256::digest(SOURCE)),"mime":"image/svg+xml"}],
        "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"MIT","assets":"CC0-1.0","attribution":"Synthetic source pin fixture"}
    })).unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("manifest.json", manifest.as_slice()),
        ("document.json", document.as_slice()),
        ("assets/source.svg", SOURCE),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn staged(tag: &str) -> (AssetStore, tempfileish::TempDir, StagedPackage, Vec<u8>) {
    let directory = tempfileish::temp_dir(tag);
    let store = AssetStore::new(directory.path()).unwrap();
    let original = package_bytes();
    let source = directory.path().join("source.hwpkg");
    std::fs::write(&source, &original).unwrap();
    let snapshot = store.snapshot_input(JOB, &source, None).unwrap();
    let package = store.validate_staged(JOB).unwrap();
    assert_eq!(snapshot.sha256, package.package_hash);
    store.unpack_projection(JOB, &package).unwrap();
    std::fs::remove_file(&source).unwrap();
    (store, directory, package, original)
}

fn source_entry(package: &StagedPackage) -> &hertz_wallpaper::VerifiedEntry {
    package
        .entries
        .iter()
        .find(|entry| entry.path == "assets/source.svg")
        .unwrap()
}

fn exclusive_write(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(path)
}

fn assert_writable(directory: &Path) {
    for path in [
        directory.join("original.hwpkg"),
        directory.join("files/assets/source.svg"),
    ] {
        drop(exclusive_write(&path).unwrap());
    }
}

fn assert_pin_identity(pin: &PinnedMedia, package: &StagedPackage) {
    let entry = source_entry(package);
    assert_eq!(pin.entry.path, entry.path);
    assert_eq!(pin.entry.bytes, SOURCE.len() as u64);
    assert_eq!(pin.entry.sha256, format!("{:x}", Sha256::digest(SOURCE)));
    assert_eq!(pin.entry.mime.as_deref(), Some("image/svg+xml"));
    assert_eq!(std::fs::read(&pin.path).unwrap(), SOURCE);
}

#[test]
fn blocked_read_keeps_real_file_pinned_until_read_returns_and_thread_exits() {
    use std::{sync::mpsc, time::Duration};

    struct BlockingRead {
        file: std::fs::File,
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
        reads: usize,
    }
    impl Read for BlockingRead {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            if self.reads == 1 {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
            self.file.read(buffer)
        }
    }

    let (store, _directory, _package, _original) = staged("source-pin-blocked-read");
    let projection = store.staging_dir(JOB).join("files/assets/source.svg");
    let file = open_immutable(&projection).unwrap();
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (result_tx, result_rx) = mpsc::sync_channel(1);
        let cancel = &cancel;
        let worker = scope.spawn(move || {
            let mut reader = BlockingRead {
                file,
                entered: entered_tx,
                release: release_rx,
                reads: 0,
            };
            let result = read_source_sha256(&mut reader, cancel);
            let reads = reader.reads;
            drop(reader);
            result_tx.send((result, reads)).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        cancel.store(true, Ordering::Release);
        let still_pending = matches!(result_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        let still_pinned = exclusive_write(&projection)
            .err()
            .and_then(|error| error.raw_os_error());
        // Release before assertions so an assertion failure cannot strand the test thread.
        release_tx.send(()).unwrap();
        let (result, reads) = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        assert!(
            still_pending,
            "cancellation cannot finish a blocked synchronous read"
        );
        assert_eq!(still_pinned, Some(32));
        assert_eq!(result.unwrap_err().code, "cancelled");
        assert_eq!(reads, 1);
    });
    drop(exclusive_write(&projection).unwrap());
}

#[test]
fn staged_and_reopened_installed_source_pins_preserve_identity_and_last_drop_unlocks_files() {
    let (store, directory, package, original) = staged("source-pin-reopen");
    let cancel = AtomicBool::new(false);
    let pin = store
        .pin_source_entry(&package, source_entry(&package), Some(JOB), &cancel)
        .unwrap();
    assert_pin_identity(&pin, &package);
    assert_eq!(
        std::fs::read(store.staging_dir(JOB).join("original.hwpkg")).unwrap(),
        original
    );
    drop(pin);
    store
        .content_writer()
        .unwrap()
        .publish_staging(JOB, &package.package_hash)
        .unwrap();
    let package_hash = package.package_hash.clone();
    drop(store);
    let reopened = AssetStore::new(directory.path()).unwrap();
    let installed = reopened.read_installed_manifest(&package_hash).unwrap();
    assert_eq!(
        source_entry(&installed).sha256,
        source_entry(&package).sha256
    );
    let pin = reopened
        .pin_source_entry(&installed, source_entry(&installed), None, &cancel)
        .unwrap();
    assert_pin_identity(&pin, &installed);
    let original_path = reopened.package_dir(&package_hash).join("original.hwpkg");
    assert_eq!(std::fs::read(&original_path).unwrap(), original);
    let projection = pin.path.clone();
    let last_pin = Arc::clone(&pin);
    drop(pin);
    for path in [&original_path, &projection] {
        assert_eq!(exclusive_write(path).unwrap_err().raw_os_error(), Some(32));
    }
    drop(last_pin);
    assert_writable(&reopened.package_dir(&package_hash));
}

#[test]
fn initial_source_pin_cancellation_keeps_no_file_handles() {
    let (store, _directory, package, _original) = staged("source-pin-initial-cancel");
    let cancel = AtomicBool::new(true);
    let error = store
        .pin_source_entry(&package, source_entry(&package), Some(JOB), &cancel)
        .err()
        .unwrap();
    assert_eq!(error.code, "cancelled");
    assert_writable(&store.staging_dir(JOB));
    // Cancellation precedes even the attempted open of a nonexistent original.
    let error = store
        .pin_source_entry(&package, source_entry(&package), Some("missing"), &cancel)
        .err()
        .unwrap();
    assert_eq!(error.code, "cancelled");
}

#[test]
fn foreign_entry_path_hash_bytes_and_mime_are_rejected_without_retaining_pins() {
    let (store, _directory, package, _original) = staged("source-pin-entry-identity");
    let cancel = AtomicBool::new(false);
    for changed in 0..4 {
        let mut entry = source_entry(&package).clone();
        match changed {
            0 => entry.path = "assets/other.svg".into(),
            1 => entry.sha256 = "00".repeat(32),
            2 => entry.bytes += 1,
            _ => entry.mime = Some("image/png".into()),
        }
        let error = store
            .pin_source_entry(&package, &entry, Some(JOB), &cancel)
            .err()
            .unwrap();
        assert_eq!(error.code, "hash_mismatch");
        assert_eq!(error.message, "准备条目不属于已核验包");
        assert_writable(&store.staging_dir(JOB));
    }
}

#[test]
fn changed_original_or_projection_hash_and_length_are_rejected_and_release_all_handles() {
    let (store, _directory, package, original) = staged("source-pin-content-identity");
    let cancel = AtomicBool::new(false);
    let directory = store.staging_dir(JOB);
    let original_path = directory.join("original.hwpkg");
    let projection = directory.join("files/assets/source.svg");
    let mut changed_original = original.clone();
    changed_original[0] ^= 1;
    std::fs::write(&original_path, changed_original).unwrap();
    let error = store
        .pin_source_entry(&package, source_entry(&package), Some(JOB), &cancel)
        .err()
        .unwrap();
    assert_eq!(error.code, "hash_mismatch");
    assert_eq!(error.message, "准备前固定原包发生变化");
    assert_writable(&directory);
    std::fs::write(&original_path, original).unwrap();
    for (changed, message) in [
        (vec![b' '; SOURCE.len()], "准备源哈希发生变化"),
        (vec![b' '; SOURCE.len() - 1], "准备源大小发生变化"),
    ] {
        std::fs::write(&projection, changed).unwrap();
        let error = store
            .pin_source_entry(&package, source_entry(&package), Some(JOB), &cancel)
            .err()
            .unwrap();
        assert_eq!(error.code, "hash_mismatch");
        assert_eq!(error.message, message);
        assert_writable(&directory);
    }
}
