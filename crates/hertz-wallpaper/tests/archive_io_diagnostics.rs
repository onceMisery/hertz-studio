// SPDX-License-Identifier: MIT
//! Real ZIP phase faults measure the diagnostic owner, not a universal archive
//! or manifest workspace bound. Input and external error text are preowned.

use hertz_wallpaper::{archive::inspect_package_identity, validate_package, PackageError};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

struct Meter;
thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}
fn add(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| {
            live.set(live.get().checked_add(bytes).unwrap());
            PEAK.with(|peak| peak.set(peak.get().max(live.get())));
        });
    }
}
fn sub(bytes: usize) {
    if ENABLED.with(Cell::get) {
        LIVE.with(|live| live.set(live.get().checked_sub(bytes).unwrap()));
    }
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        sub(layout.size());
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, old: Layout, bytes: usize) -> *mut u8 {
        // Count old+new requested layouts even when System resizes in place.
        add(bytes);
        let result = unsafe { System.realloc(pointer, old, bytes) };
        if result.is_null() {
            sub(bytes);
        } else {
            sub(old.size());
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;

const ENTRY: &str = "assets/data.bin";
const DOCUMENT: &str = "document.json";
struct Fixture {
    bytes: Vec<u8>,
    manifest_start: u64,
    entry_start: u64,
    document_start: u64,
}
fn fixture(method: CompressionMethod, entry_path: &str) -> Fixture {
    let entry: Vec<u8> = (0..173).map(|i| ((i * 73 + 19) % 251) as u8).collect();
    let document = serde_json::to_vec(&json!({"documentVersion":1,
        "canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#101010"},
        "nodes":[],"timeline":{"durationSeconds":30,"loop":true,"tracks":[]},
        "bindings":[]}))
    .unwrap();
    // Stored padding places the footer/central directory well beyond all fault
    // locations. Faults additionally arm only on an exact payload-start seek.
    let padding: Vec<u8> = (0..70_000).map(|i| (i % 251) as u8).collect();
    let files = [
        (entry_path, entry.as_slice(), "application/octet-stream"),
        (DOCUMENT, document.as_slice(), "application/json"),
        (
            "padding.bin",
            padding.as_slice(),
            "application/octet-stream",
        ),
    ];
    let manifest = serde_json::to_vec(&json!({"formatVersion":1,
        "workId":"8bc16f98-a0ef-4df9-a9a4-aecdb4c3f772","version":1,"title":"Archive diagnostics",
        "content":{"kind":"composition","document":DOCUMENT},"assets":[],
        "files":files.iter().map(|(path, bytes, mime)| json!({"path":path,
            "bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),
            "mime":mime})).collect::<Vec<_>>(),
        "permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}}))
    .unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "manifest.json",
            SimpleFileOptions::default().compression_method(method),
        )
        .unwrap();
    writer.write_all(&manifest).unwrap();
    for (path, bytes, _) in files {
        let compression = if path == "padding.bin" {
            CompressionMethod::Stored
        } else {
            method
        };
        writer
            .start_file(
                path,
                SimpleFileOptions::default().compression_method(compression),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    let bytes = writer.finish().unwrap().into_inner();
    let mut zip = ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
    let manifest_start = zip.by_name("manifest.json").unwrap().data_start();
    let entry_start = zip.by_name(entry_path).unwrap().data_start();
    let document_start = zip.by_name(DOCUMENT).unwrap().data_start();
    assert!(zip.central_directory_start() > document_start + 65_557);
    drop(zip);
    // The unchanged complete owner must accept the same real fixture.
    validate_package(Cursor::new(bytes.as_slice())).unwrap();
    Fixture {
        bytes,
        manifest_start,
        entry_start,
        document_start,
    }
}

struct Payload {
    text: String,
    display: AtomicUsize,
    debug: AtomicUsize,
    source: AtomicUsize,
}
struct ExternalError(Arc<Payload>);
impl std::fmt::Display for ExternalError {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.display.fetch_add(1, Ordering::Relaxed);
        panic!("external Display must never execute");
    }
}
impl std::fmt::Debug for ExternalError {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.debug.fetch_add(1, Ordering::Relaxed);
        panic!("external Debug must never execute");
    }
}
impl std::error::Error for ExternalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source.fetch_add(1, Ordering::Relaxed);
        panic!("external Source must never execute");
    }
}
#[derive(Clone, Copy)]
enum Fault<'a> {
    External(&'a Arc<Payload>),
    Os(i32),
    Eof,
}
impl Fault<'_> {
    fn outcome(self) -> io::Result<usize> {
        match self {
            Self::External(payload) => Err(io::Error::other(ExternalError(Arc::clone(payload)))),
            Self::Os(code) => Err(io::Error::from_raw_os_error(code)),
            Self::Eof => Ok(0),
        }
    }
}
#[derive(Clone, Copy, Debug)]
enum Phase {
    End,
    Start,
    Manifest,
    Hash,
    Composition,
}
struct FaultReader<'a> {
    input: Cursor<&'a [u8]>,
    phase: Phase,
    start: u64,
    delta: u64,
    visit: usize,
    visits: usize,
    fault: Fault<'a>,
    failures: usize,
    reads: usize,
    seeks: usize,
    reads_after: usize,
    seeks_after: usize,
    payload_bytes: u64,
    trace: [u8; 256],
    trace_len: usize,
}
impl FaultReader<'_> {
    fn record(&mut self, event: u8) {
        self.trace[self.trace_len] = event;
        self.trace_len += 1;
    }
}
impl Read for FaultReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.record(b'R');
        self.reads += 1;
        self.reads_after += usize::from(self.failures != 0);
        let position = self.input.position();
        let active = self.visits == self.visit && self.visit != 0;
        let count = if active && position <= self.start + self.delta {
            if position == self.start + self.delta {
                self.record(b'F');
                self.failures += 1;
                return self.fault.outcome();
            }
            output
                .len()
                .min((self.start + self.delta - position) as usize)
        } else {
            output.len()
        };
        let read = self.input.read(&mut output[..count])?;
        if active {
            self.payload_bytes += read as u64;
        }
        Ok(read)
    }
}
impl Seek for FaultReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.record(match position {
            SeekFrom::End(_) => b'E',
            SeekFrom::Start(_) => b'S',
            SeekFrom::Current(_) => b'C',
        });
        self.seeks += 1;
        self.seeks_after += usize::from(self.failures != 0);
        let fail = matches!(
            (self.phase, self.seeks, position),
            (Phase::End, 1, SeekFrom::End(0)) | (Phase::Start, 2, SeekFrom::Start(0))
        );
        if fail {
            self.record(b'F');
            self.failures += 1;
            return self.fault.outcome().map(|_| 0);
        }
        if self.visit != 0 && position == SeekFrom::Start(self.start) {
            self.visits += 1;
            self.record(b'P');
        }
        self.input.seek(position)
    }
}

fn run(fixture: &Fixture, phase: Phase, delta: u64, fault: Fault<'_>, entry: &str) {
    let (start, visit, operation, path, offset, code) = match phase {
        Phase::End => (
            0,
            0,
            "package end seek failed",
            None,
            None,
            "format_unsupported",
        ),
        Phase::Start => (
            0,
            0,
            "package start seek failed",
            None,
            Some(0),
            "format_unsupported",
        ),
        Phase::Manifest => (
            fixture.manifest_start,
            1,
            "manifest read failed",
            Some("manifest.json"),
            Some(delta),
            "format_unsupported",
        ),
        Phase::Hash => (
            fixture.entry_start,
            1,
            "archive entry read failed",
            Some(entry),
            Some(delta),
            "format_unsupported",
        ),
        Phase::Composition => (
            fixture.document_start,
            2,
            "composition read failed",
            Some(DOCUMENT),
            Some(delta),
            "invalid_composition",
        ),
    };
    let (kind, os) = match fault {
        Fault::External(_) => (io::ErrorKind::Other, None),
        Fault::Os(code) => (io::Error::from_raw_os_error(code).kind(), Some(code)),
        // The original ZIP CRC owner turns a short physical EOF into InvalidData.
        Fault::Eof => (io::ErrorKind::InvalidData, None),
    };
    let mut expected = format!("{operation}: kind={kind:?}, raw_os_error={os:?}");
    if let Some(path) = path {
        write!(expected, " (path {path})").unwrap();
    }
    if let Some(offset) = offset {
        write!(expected, " (byte {offset})").unwrap();
    }
    let mut reader = FaultReader {
        input: Cursor::new(&fixture.bytes),
        phase,
        start,
        delta,
        visit,
        visits: 0,
        fault,
        failures: 0,
        reads: 0,
        seeks: 0,
        reads_after: 0,
        seeks_after: 0,
        payload_bytes: 0,
        trace: [0; 256],
        trace_len: 0,
    };
    LIVE.with(|value| value.set(0));
    PEAK.with(|value| value.set(0));
    ENABLED.with(|value| value.set(true));
    let error: PackageError = if matches!(phase, Phase::Composition) {
        validate_package(&mut reader).unwrap_err()
    } else {
        inspect_package_identity(&mut reader).unwrap_err()
    };
    let retained = LIVE.with(Cell::get);
    let message_bytes = error.message.len();
    let message_capacity = error.message.capacity();
    let message_matches = error.message == expected;
    let returned_code = error.code;
    drop(error);
    ENABLED.with(|value| value.set(false));
    assert_eq!(
        LIVE.with(Cell::get),
        0,
        "all phase/reader/error heap must drop"
    );
    assert_eq!(reader.failures, 1);
    assert_eq!(
        (reader.reads_after, reader.seeks_after),
        (0, 0),
        "no physical operation after failure"
    );
    assert_eq!(
        reader.visits, visit,
        "fault armed only on intended payload visit"
    );
    assert_eq!(
        reader.input.position(),
        match phase {
            Phase::End => 0,
            Phase::Start => fixture.bytes.len() as u64,
            _ => start + delta,
        }
    );
    assert_eq!(reader.payload_bytes, delta);
    assert_eq!(returned_code, code);
    assert!(
        message_matches,
        "exact operation/scalar/path/logical offset"
    );
    // Source-derived upper envelope for these bounded callers. This does
    // not compare the entire archive peak against a manifest theorem.
    assert!(message_bytes <= 302);
    assert!(message_capacity <= 604);
    if let Fault::External(payload) = fault {
        assert_eq!(
            (
                payload.display.load(Ordering::Relaxed),
                payload.debug.load(Ordering::Relaxed),
                payload.source.load(Ordering::Relaxed)
            ),
            (0, 0, 0)
        );
        assert_eq!(
            Arc::strong_count(payload),
            1,
            "external wrapper physically dropped"
        );
    }
    println!("archive_io phase={phase:?} compressed_start={start} payload_visit={visit} physical_delta={delta} reads={} seeks={} code={returned_code} exact_message={message_matches} message_bytes={message_bytes} message_capacity={message_capacity} peak={} retained={retained} failures=1 later_reads=0 later_seeks=0 drop=0", reader.reads, reader.seeks, PEAK.with(Cell::get));
    println!("operation_trace={} E=end_seek S=start_seek C=current_seek R=read P=target_payload_seek F=fault", std::str::from_utf8(&reader.trace[..reader.trace_len]).unwrap());
}

#[test]
fn original_archive_phase_faults_are_bounded_and_exit_physically() {
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        let fixture = fixture(method, ENTRY);
        println!(
            "fixture compression={method:?} bytes={} sha256={:x}",
            fixture.bytes.len(),
            Sha256::digest(&fixture.bytes)
        );
        for payload_bytes in [64 * 1024, 128 * 1024] {
            let payload = Arc::new(Payload {
                text: "x".repeat(payload_bytes),
                display: AtomicUsize::new(0),
                debug: AtomicUsize::new(0),
                source: AtomicUsize::new(0),
            });
            for phase in [
                Phase::End,
                Phase::Start,
                Phase::Manifest,
                Phase::Hash,
                Phase::Composition,
            ] {
                run(&fixture, phase, 0, Fault::External(&payload), ENTRY);
                if method == CompressionMethod::Stored
                    && matches!(phase, Phase::Manifest | Phase::Hash | Phase::Composition)
                {
                    run(&fixture, phase, 3, Fault::External(&payload), ENTRY);
                }
            }
            assert_eq!(payload.text.len(), payload_bytes);
            println!("preowned_payload={payload_bytes} Display=0 Debug=0 Source=0 wrapper_drop=0");
        }
        for os in [i32::MIN, i32::MAX] {
            for phase in [
                Phase::End,
                Phase::Start,
                Phase::Manifest,
                Phase::Hash,
                Phase::Composition,
            ] {
                run(&fixture, phase, 0, Fault::Os(os), ENTRY);
            }
        }
        if method == CompressionMethod::Stored {
            for phase in [Phase::Manifest, Phase::Hash, Phase::Composition] {
                run(&fixture, phase, 3, Fault::Eof, ENTRY);
            }
        }
    }
    let longest = "a".repeat(hertz_wallpaper::MAX_PATH_BYTES);
    let fixture = fixture(CompressionMethod::Stored, &longest);
    run(&fixture, Phase::Hash, 3, Fault::Os(i32::MIN), &longest);
}
