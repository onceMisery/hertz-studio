// SPDX-License-Identifier: MIT
//! Cooperative cancellation on the actual full GLB stream, without a loader.

use hertz_wallpaper::{
    model_binary::{inspect_glb_resource_content, inspect_glb_resource_content_with_cancel},
    model_container::{inspect_glb, inspect_glb_with_cancel},
    Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    fmt,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc,
    },
    thread,
    time::Duration,
};

const WINDOW: usize = 64 * 1024;

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Cancellation fixture","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}

fn document() -> Value {
    json!({"asset":{"version":"2.0"},"extras":{"padding":"x".repeat(WINDOW + 4096)},
        "buffers":[{"byteLength":3 * WINDOW}],
        "bufferViews":[{"buffer":0,"byteLength":36,"target":34962},
            {"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
            {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],"nodes":[{"mesh":0}]})
}

fn glb(document: &Value) -> (Vec<u8>, u64) {
    let mut text = serde_json::to_vec(document).unwrap();
    text.resize(text.len().div_ceil(4) * 4, b' ');
    let bin_start = 28 + text.len();
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2u32.to_le_bytes());
    bytes.extend(((bin_start + 3 * WINDOW) as u32).to_le_bytes());
    bytes.extend((text.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(text);
    bytes.extend((3u32 * WINDOW as u32).to_le_bytes());
    bytes.extend([b'B', b'I', b'N', 0]);
    for value in [0f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
        bytes.extend(value.to_le_bytes());
    }
    for index in [0u16, 1, 2] {
        bytes.extend(index.to_le_bytes());
    }
    bytes.resize(bin_start + 3 * WINDOW, 0);
    (bytes, bin_start as u64)
}

#[derive(Clone, Copy)]
enum Reply {
    Progress,
    Interrupted,
    Eof,
    Error,
}

#[derive(Default)]
struct Payload {
    display: AtomicUsize,
    debug: AtomicUsize,
    source: AtomicUsize,
}
impl fmt::Display for Payload {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.display.fetch_add(1, Ordering::Relaxed);
        output.write_str("external payload must never be formatted")
    }
}
impl fmt::Debug for Payload {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.debug.fetch_add(1, Ordering::Relaxed);
        output.write_str("external payload must never be formatted")
    }
}
impl std::error::Error for Payload {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.fetch_add(1, Ordering::Relaxed);
        None
    }
}

struct Spy<'a> {
    input: Cursor<&'a [u8]>,
    cancel: Option<&'a AtomicBool>,
    at: Option<u64>,
    reply: Reply,
    fired: bool,
    calls: usize,
    after: usize,
    largest: usize,
    progress: usize,
    payload: Arc<Payload>,
}
impl<'a> Spy<'a> {
    fn new(bytes: &'a [u8], cancel: Option<&'a AtomicBool>, at: Option<u64>, reply: Reply) -> Self {
        Self {
            input: Cursor::new(bytes),
            cancel,
            at,
            reply,
            fired: false,
            calls: 0,
            after: 0,
            largest: 0,
            progress: WINDOW,
            payload: Arc::new(Payload::default()),
        }
    }
}
impl Read for Spy<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.calls += 1;
        self.after += usize::from(self.fired);
        self.largest = self.largest.max(output.len());
        assert!(output.len() <= WINDOW, "bottom request exceeds 64 KiB");
        if !self.fired && self.at == Some(self.input.position()) {
            self.fired = true;
            if let Some(cancel) = self.cancel {
                cancel.store(true, Ordering::Release);
            }
            return match self.reply {
                Reply::Progress => self.input.read(&mut output[..1]),
                Reply::Interrupted => Err(io::ErrorKind::Interrupted.into()),
                Reply::Eof => Ok(0),
                Reply::Error => Err(io::Error::other(Arc::clone(&self.payload))),
            };
        }
        let mut count = output.len().min(self.progress);
        if !self.fired {
            if let Some(at) = self.at {
                count = count.min((at - self.input.position()) as usize);
            }
        }
        self.input.read(&mut output[..count])
    }
}

#[test]
fn legacy_and_cancel_apis_keep_full_schema_numeric_digest_and_bounded_bottom_reads() {
    let manifest = manifest();
    let (bytes, _) = glb(&document());
    let token = AtomicBool::new(false);
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    for cancelled_api in [false, true] {
        // A single Interrupted and small partial progress exercise the manual
        // original loop, including whole JSON chunks larger than its cap.
        let mut input = Spy::new(&bytes, None, Some(21), Reply::Interrupted);
        input.progress = 4093;
        let checked = if cancelled_api {
            inspect_glb_resource_content_with_cancel(
                &mut input,
                bytes.len() as u64,
                &manifest,
                "assets/model.glb",
                Some(&token),
            )
        } else {
            inspect_glb_resource_content(
                &mut input,
                bytes.len() as u64,
                &manifest,
                "assets/model.glb",
            )
        }
        .unwrap();
        assert_eq!(checked.sha256(), &digest);
        assert_eq!(checked.bytes(), bytes.len() as u64);
        assert_eq!(checked.checked_elements(), 6);
        assert_eq!(checked.checked_components(), 12);
        assert_eq!(checked.checked_accessors(), 2);
        assert_eq!(checked.resource().structure.nodes.len(), 1);
        assert!(input.fired && input.after > 0);
        assert_eq!(input.largest, WINDOW);
        let mut framing = Spy::new(&bytes, None, None, Reply::Progress);
        let container = if cancelled_api {
            inspect_glb_with_cancel(&mut framing, bytes.len() as u64, Some(&token))
        } else {
            inspect_glb(&mut framing, bytes.len() as u64)
        }
        .unwrap();
        assert!(container.json.len() > WINDOW);
        assert_eq!(framing.largest, WINDOW);
    }
    let mut changed = bytes.clone();
    *changed.last_mut().unwrap() = 1;
    let checked = inspect_glb_resource_content_with_cancel(
        Cursor::new(&changed),
        changed.len() as u64,
        &manifest,
        "assets/model.glb",
        Some(&token),
    )
    .unwrap();
    assert_ne!(
        checked.sha256(),
        &digest,
        "unused BIN participates in the digest"
    );
}

#[test]
fn initial_cancel_precedes_invalid_length_and_unbounded_path_without_any_read() {
    let token = AtomicBool::new(true);
    let path = "x".repeat(hertz_wallpaper::MAX_PATH_BYTES + 1);
    let mut input = Spy::new(&[], None, None, Reply::Progress);
    let error = inspect_glb_with_cancel(&mut input, 1, Some(&token)).unwrap_err();
    assert_eq!(error.code, "cancelled");
    let error =
        inspect_glb_resource_content_with_cancel(&mut input, 1, &manifest(), &path, Some(&token))
            .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(error.message, "resource inspection cancelled");
    assert_eq!(input.calls, 0);
}

#[test]
fn cancellation_header_json_numeric_unused_bin_and_footer_has_no_subsequent_read() {
    let manifest = manifest();
    let (bytes, bin) = glb(&document());
    for (label, at) in [
        ("header", 0),
        ("JSON", 20 + WINDOW as u64),
        ("numeric", bin),
        ("unused BIN", bin + WINDOW as u64),
        ("footer", bytes.len() as u64),
    ] {
        for reply in [Reply::Progress, Reply::Interrupted, Reply::Eof] {
            let token = AtomicBool::new(false);
            let mut input = Spy::new(&bytes, Some(&token), Some(at), reply);
            let error = inspect_glb_resource_content_with_cancel(
                &mut input,
                bytes.len() as u64,
                &manifest,
                "assets/model.glb",
                Some(&token),
            )
            .unwrap_err();
            assert_eq!(error.code, "cancelled", "{label}");
            assert_eq!(input.after, 0, "{label}");
            assert!(input.fired, "{label}");
        }
    }
}

#[test]
fn cancellation_survives_binary_window_skip_gap_mapping() {
    let mut doc = document();
    doc.as_object_mut().unwrap().remove("meshes");
    doc.as_object_mut().unwrap().remove("nodes");
    doc["bufferViews"] = json!([{"buffer":0,"byteOffset":2 * WINDOW,"byteLength":4}]);
    doc["accessors"] = json!([{"bufferView":0,"componentType":5126,"count":1,"type":"SCALAR"}]);
    let (bytes, bin) = glb(&doc);
    let token = AtomicBool::new(false);
    let mut input = Spy::new(&bytes, Some(&token), Some(bin), Reply::Progress);
    let error = inspect_glb_resource_content_with_cancel(
        &mut input,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
        Some(&token),
    )
    .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(input.after, 0);
}

#[test]
fn real_io_failure_wins_racing_cancel_without_external_formatting() {
    let manifest = manifest();
    let (bytes, bin) = glb(&document());
    for (at, offset, code, operation) in [
        (0, 0, "invalid_model_container", "short or failed read"),
        (21, 20, "invalid_model_container", "short or failed read"),
        (bin + 1, bin, "invalid_model_binary", "short or failed read"),
        (
            bytes.len() as u64,
            bytes.len() as u64,
            "invalid_model_container",
            "end-of-entry read failed",
        ),
    ] {
        let token = AtomicBool::new(false);
        let mut input = Spy::new(&bytes, Some(&token), Some(at), Reply::Error);
        let error = inspect_glb_resource_content_with_cancel(
            &mut input,
            bytes.len() as u64,
            &manifest,
            "assets/model.glb",
            Some(&token),
        )
        .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(
            error.message,
            format!("{operation}: kind=Other, raw_os_error=None (byte {offset})")
        );
        assert_eq!(input.after, 0);
        assert_eq!(input.payload.display.load(Ordering::Relaxed), 0);
        assert_eq!(input.payload.debug.load(Ordering::Relaxed), 0);
        assert_eq!(input.payload.source.load(Ordering::Relaxed), 0);
        assert_eq!(Arc::strong_count(&input.payload), 1);
    }
}

#[test]
fn uncancelled_footer_interrupted_preserves_immediate_failure() {
    let (bytes, _) = glb(&document());
    let token = AtomicBool::new(false);
    for cancel in [None, Some(&token)] {
        let mut input = Spy::new(&bytes, None, Some(bytes.len() as u64), Reply::Interrupted);
        let error = inspect_glb_with_cancel(&mut input, bytes.len() as u64, cancel).unwrap_err();
        assert_eq!(error.code, "invalid_model_container");
        assert!(error
            .message
            .starts_with("end-of-entry read failed: kind=Interrupted"));
        assert_eq!(input.after, 0);
    }
}

#[test]
fn hostile_unselected_schema_and_numeric_values_still_fail() {
    let token = AtomicBool::new(false);
    let manifest = manifest();
    let mut doc = document();
    // An unused node is still part of the original full schema validation.
    doc["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"children":[1]}));
    let (bytes, _) = glb(&doc);
    let error = inspect_glb_resource_content_with_cancel(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        "assets/model.glb",
        Some(&token),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_model_structure");
    let mut doc = document();
    doc["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":WINDOW,"byteLength":4}));
    doc["accessors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":2,"componentType":5126,"count":1,"type":"SCALAR"}));
    let (mut bytes, bin) = glb(&doc);
    bytes[bin as usize + WINDOW..bin as usize + WINDOW + 4]
        .copy_from_slice(&f32::NAN.to_le_bytes());
    let error = inspect_glb_resource_content_with_cancel(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest,
        "assets/model.glb",
        Some(&token),
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_model_binary");
}

struct Blocked {
    input: Cursor<Vec<u8>>,
    at: u64,
    entered: Sender<()>,
    release: Receiver<()>,
    dropped: Arc<AtomicBool>,
}
impl Drop for Blocked {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
    }
}
impl Read for Blocked {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.input.position() == self.at {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
        }
        self.input.read(output)
    }
}

// The guard releases and joins even if a main-thread assertion unwinds.
struct ReleaseJoin {
    release: Option<Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for ReleaseJoin {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[test]
fn blocked_read_retains_resources_until_release_then_returns_cancelled() {
    let (bytes, _) = glb(&document());
    let length = bytes.len() as u64;
    let cancel = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let input = Blocked {
        input: Cursor::new(bytes),
        at: 20,
        entered: entered_tx,
        release: release_rx,
        dropped: Arc::clone(&dropped),
    };
    let worker_cancel = Arc::clone(&cancel);
    let worker = thread::spawn(move || {
        let result = inspect_glb_resource_content_with_cancel(
            input,
            length,
            &manifest(),
            "assets/model.glb",
            Some(&worker_cancel),
        );
        done_tx.send(result.unwrap_err().code).unwrap();
    });
    let mut guard = ReleaseJoin {
        release: Some(release_tx),
        worker: Some(worker),
    };
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    cancel.store(true, Ordering::Release);
    assert_eq!(done_rx.try_recv(), Err(TryRecvError::Empty));
    assert!(!dropped.load(Ordering::Acquire));
    guard.release.take().unwrap().send(()).unwrap();
    assert_eq!(
        done_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        "cancelled"
    );
    guard.worker.take().unwrap().join().unwrap();
    assert!(dropped.load(Ordering::Acquire));
}

struct ZipSource<'a> {
    input: Cursor<Vec<u8>>,
    cancel: &'a AtomicBool,
    at: &'a Cell<Option<u64>>,
    fired: &'a Cell<bool>,
    after: &'a Cell<usize>,
}
impl Read for ZipSource<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.after
            .set(self.after.get() + usize::from(self.fired.get()));
        let mut count = output.len();
        if let Some(at) = self.at.get() {
            if self.input.position() == at {
                let count = self.input.read(&mut output[..1])?;
                self.fired.set(true);
                self.cancel.store(true, Ordering::Release);
                return Ok(count);
            }
            count = count.min((at - self.input.position()) as usize);
        }
        self.input.read(&mut output[..count])
    }
}
impl Seek for ZipSource<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.input.seek(position)
    }
}

#[test]
fn original_stored_zip_typed_cancellation_survives_glb_reader_with_token_only() {
    let (bytes, bin) = glb(&document());
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "assets/model.glb",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    writer.write_all(&bytes).unwrap();
    let zip_bytes = writer.finish().unwrap().into_inner();
    for (position, legacy_code) in [
        (0, "invalid_model_container"),
        (20 + WINDOW as u64, "invalid_model_container"),
        (bin, "invalid_model_binary"),
    ] {
        for with_token in [false, true] {
            let token = AtomicBool::new(false);
            let at = Cell::new(None);
            let fired = Cell::new(false);
            let after = Cell::new(0);
            let source = ZipSource {
                input: Cursor::new(zip_bytes.clone()),
                cancel: &token,
                at: &at,
                fired: &fired,
                after: &after,
            };
            let mut archive = zip::ZipArchive::new(source).unwrap();
            let file = archive.by_index_with_cancel(0, &token).unwrap();
            at.set(Some(file.data_start() + position));
            let error = inspect_glb_resource_content_with_cancel(
                file,
                bytes.len() as u64,
                &manifest(),
                "assets/model.glb",
                with_token.then_some(&token),
            )
            .unwrap_err();
            assert_eq!(
                error.code,
                if with_token { "cancelled" } else { legacy_code }
            );
            assert!(fired.get());
            assert_eq!(
                after.get(),
                0,
                "no underlying read follows nested cancellation"
            );
        }
    }
}
