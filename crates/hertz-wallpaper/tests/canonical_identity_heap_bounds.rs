// SPDX-License-Identifier: MIT
//! Real System allocations (realloc old+new overlap), original ZIP operations,
//! bottom-read cancellation and natural reader destruction. Samples falsify the
//! source envelope; they never define its coefficients. Caller storage/errors
//! are created before metering and are not mistaken for parser-owned requests.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    error::Error,
    fmt,
    io::{self, Cursor, Read, Seek, SeekFrom},
    ops::Range,
    process::Command,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
};

use hertz_wallpaper::{
    archive::{
        inspect_package_identity, inspect_package_identity_with_limits_and_cancel,
        CanonicalIdentityHeapBounds,
    },
    MAX_FILES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use zip::{read::MetadataLimits, CompressionMethod, ZipArchive};

struct Meter;
static TRACK: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static REQUESTS: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
static RAW_GROWTH: AtomicUsize = AtomicUsize::new(0);
static LOWER_TABLE: AtomicUsize = AtomicUsize::new(0);
static DECLARED_TABLE: AtomicUsize = AtomicUsize::new(0);
static POINTERS: [AtomicUsize; 32768] = [const { AtomicUsize::new(0) }; 32768];
static SIZES: [AtomicUsize; 32768] = [const { AtomicUsize::new(0) }; 32768];

fn charge(bytes: usize) {
    let live = LIVE.fetch_add(bytes, SeqCst) + bytes;
    PEAK.fetch_max(live, SeqCst);
    LARGEST.fetch_max(bytes, SeqCst);
    REQUESTS.fetch_add(1, SeqCst);
    if bytes == 102416 {
        LOWER_TABLE.fetch_add(1, SeqCst);
    }
    if bytes == 69648 {
        DECLARED_TABLE.fetch_add(1, SeqCst);
    }
}
fn record(pointer: *mut u8, bytes: usize) {
    if pointer.is_null() || !TRACK.load(SeqCst) {
        return;
    }
    charge(bytes);
    for i in 0..POINTERS.len() {
        if POINTERS[i]
            .compare_exchange(0, pointer as usize, SeqCst, SeqCst)
            .is_ok()
        {
            SIZES[i].store(bytes, SeqCst);
            return;
        }
    }
    std::process::abort();
}
fn forget(pointer: *mut u8) -> bool {
    if LIVE.load(SeqCst) == 0 {
        return false;
    }
    for i in 0..POINTERS.len() {
        if POINTERS[i].load(SeqCst) == pointer as usize {
            LIVE.fetch_sub(SIZES[i].swap(0, SeqCst), SeqCst);
            POINTERS[i].store(0, SeqCst);
            return true;
        }
    }
    false
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        record(p, layout.size());
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        record(p, layout.size());
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        forget(p);
        unsafe { System.dealloc(p, layout) };
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, bytes: usize) -> *mut u8 {
        let tracked = POINTERS.iter().any(|slot| slot.load(SeqCst) == p as usize);
        if tracked {
            charge(bytes);
            if layout.size() == 262144 && bytes == 524288 {
                RAW_GROWTH.fetch_add(1, SeqCst);
            }
        }
        let new = unsafe { System.realloc(p, layout, bytes) };
        if tracked {
            LIVE.fetch_sub(bytes, SeqCst);
            if !new.is_null() {
                forget(p);
                record(new, bytes);
            }
        } else {
            record(new, bytes);
        }
        new
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;

#[derive(Debug)]
struct Observation {
    peak: usize,
    retained: usize,
    requests: usize,
    largest: usize,
    raw_growth: usize,
}
fn begin() {
    assert_eq!(LIVE.load(SeqCst), 0);
    for value in [
        &PEAK,
        &REQUESTS,
        &LARGEST,
        &RAW_GROWTH,
        &LOWER_TABLE,
        &DECLARED_TABLE,
    ] {
        value.store(0, SeqCst);
    }
    TRACK.store(true, SeqCst);
}
fn end() -> Observation {
    TRACK.store(false, SeqCst);
    Observation {
        peak: PEAK.load(SeqCst),
        retained: LIVE.load(SeqCst),
        requests: REQUESTS.load(SeqCst),
        largest: LARGEST.load(SeqCst),
        raw_growth: RAW_GROWTH.load(SeqCst),
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}
#[derive(Clone)]
struct Entry {
    name: Vec<u8>,
    compressed: Vec<u8>,
    decoded: usize,
    crc: u32,
    method: u16,
    utf8: bool,
    escaping_range: bool,
}
impl Entry {
    fn stored(name: &[u8], payload: &[u8]) -> Self {
        Self {
            name: name.to_vec(),
            compressed: payload.to_vec(),
            decoded: payload.len(),
            crc: crc32(payload),
            method: 0,
            utf8: true,
            escaping_range: false,
        }
    }
    fn zero_output_deflate(name: &[u8], payload: &[u8]) -> Self {
        // 10,000 bytes of valid nonfinal empty Stored blocks produce NO output.
        // flate2 must consume the first 8192-byte fill and fill again within a
        // SINGLE logical read. The final Stored block supplies real output.
        let mut compressed = [0, 0, 0, 255, 255].repeat(2000);
        let mut remaining = payload;
        while !remaining.is_empty() {
            let take = remaining.len().min(u16::MAX as usize);
            let n = take as u16;
            compressed.push(u8::from(take == remaining.len()));
            compressed.extend_from_slice(&n.to_le_bytes());
            compressed.extend_from_slice(&(!n).to_le_bytes());
            compressed.extend_from_slice(&remaining[..take]);
            remaining = &remaining[take..];
        }
        Self {
            compressed,
            method: 8,
            ..Self::stored(name, payload)
        }
    }
}
struct Fixture {
    bytes: Vec<u8>,
    payloads: Vec<Range<u64>>,
    headers: Vec<u64>,
    directory: u64,
}
fn u16_at(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn u32_at(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn package(entries: &[Entry]) -> Fixture {
    let mut bytes = Vec::new();
    let mut headers = Vec::new();
    let mut payloads = Vec::new();
    for entry in entries {
        headers.push(bytes.len() as u64);
        let mut local = [0; 30];
        u32_at(&mut local, 0, 0x04034b50);
        u16_at(&mut local, 4, 20);
        u16_at(&mut local, 6, if entry.utf8 { 1 << 11 } else { 0 });
        u16_at(&mut local, 8, entry.method);
        u32_at(&mut local, 14, entry.crc);
        u32_at(&mut local, 18, entry.compressed.len() as u32);
        u32_at(&mut local, 22, entry.decoded as u32);
        u16_at(&mut local, 26, entry.name.len() as u16);
        bytes.extend_from_slice(&local);
        bytes.extend_from_slice(&entry.name);
        let start = bytes.len() as u64;
        bytes.extend_from_slice(&entry.compressed);
        payloads.push(start..bytes.len() as u64);
    }
    let directory = bytes.len() as u64;
    for (entry, header) in entries.iter().zip(&headers) {
        let mut central = [0; 46];
        u32_at(&mut central, 0, 0x02014b50);
        u16_at(&mut central, 4, 20);
        u16_at(&mut central, 6, 20);
        u16_at(&mut central, 8, if entry.utf8 { 1 << 11 } else { 0 });
        u16_at(&mut central, 10, entry.method);
        u32_at(&mut central, 16, entry.crc);
        let compressed = if entry.escaping_range {
            u32::MAX
        } else {
            entry.compressed.len() as u32
        };
        u32_at(&mut central, 20, compressed);
        u32_at(&mut central, 24, entry.decoded as u32);
        u16_at(&mut central, 28, entry.name.len() as u16);
        u32_at(&mut central, 42, *header as u32);
        bytes.extend_from_slice(&central);
        bytes.extend_from_slice(&entry.name);
    }
    let size = bytes.len() as u64 - directory;
    let mut end = [0; 22];
    u32_at(&mut end, 0, 0x06054b50);
    u16_at(&mut end, 8, entries.len() as u16);
    u16_at(&mut end, 10, entries.len() as u16);
    u32_at(&mut end, 12, size as u32);
    u32_at(&mut end, 16, directory as u32);
    bytes.extend_from_slice(&end);
    Fixture {
        bytes,
        payloads,
        headers,
        directory,
    }
}
fn manifest(resources: &[Entry]) -> Vec<u8> {
    let files: Vec<_> = resources
        .iter()
        .map(|entry| {
            json!([
                std::str::from_utf8(&entry.name).unwrap(),
                entry.decoded,
                format!(
                    "{:x}",
                    Sha256::digest(if entry.method == 8 {
                        b"abc".as_slice()
                    } else {
                        &entry.compressed
                    })
                ),
                "a/b"
            ])
        })
        .collect();
    serde_json::to_vec(&json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Identity envelope","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":files,"properties":[],"permissions":{},
        "license":{"code":"none","assets":"CC0-1.0"}
    })).unwrap()
}
fn fixture(deflate: bool) -> Fixture {
    let a = if deflate {
        Entry::zero_output_deflate(b"a.bin", b"abc")
    } else {
        Entry::stored(b"a.bin", b"abc")
    };
    let b = Entry::stored(b"b.bin", b"else");
    package(&[
        Entry::stored(b"manifest.json", &manifest(&[a.clone(), b.clone()])),
        a,
        b,
    ])
}
fn quotas() -> MetadataLimits {
    MetadataLimits {
        max_raw_entries: MAX_FILES + 8,
        max_variable_bytes: usize::MAX,
        max_zip64_extensible_bytes: 0,
        max_eocd_comment_bytes: 0,
    }
}
fn fees(fixture: &Fixture) -> CanonicalIdentityHeapBounds {
    assert!(fixture
        .payloads
        .iter()
        .all(|range| range.end <= fixture.directory));
    CanonicalIdentityHeapBounds::for_package_bytes::<Cursor<&[u8]>>(
        fixture.bytes.len() as u64,
        Some(quotas()),
    )
    .unwrap()
}

#[derive(Clone, Copy)]
enum Trigger {
    Never,
    Seek(usize),
    Read(usize),
    At(u64),
    EofAt(u64),
    InterruptedAt(u64),
    ErrorAt(u64, bool),
}
struct Spy<'a> {
    cursor: Cursor<&'a [u8]>,
    token: &'a AtomicBool,
    trigger: Trigger,
    reads: &'a Cell<usize>,
    seeks: &'a Cell<usize>,
    drops: &'a Cell<usize>,
    later_reads: &'a Cell<usize>,
    fired: &'a Cell<bool>,
    max_read: usize,
    error: Option<io::Error>,
    payloads: &'a [Range<u64>],
    in_payload: bool,
}
impl Read for Spy<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.reads.set(self.reads.get() + 1);
        if self.fired.get() {
            self.later_reads.set(self.later_reads.get() + 1);
        }
        let position = self.cursor.position();
        let fire = !self.fired.get()
            && match self.trigger {
                Trigger::Read(n) => self.reads.get() == n,
                Trigger::At(p)
                | Trigger::EofAt(p)
                | Trigger::InterruptedAt(p)
                | Trigger::ErrorAt(p, _) => {
                    position == p
                        && (!self.payloads.iter().any(|range| range.contains(&p))
                            || self.in_payload)
                }
                _ => false,
            };
        if fire {
            self.fired.set(true);
            if !matches!(self.trigger, Trigger::ErrorAt(_, false)) {
                self.token.store(true, SeqCst);
            }
            match self.trigger {
                Trigger::EofAt(_) => return Ok(0),
                Trigger::InterruptedAt(_) => return Err(io::ErrorKind::Interrupted.into()),
                Trigger::ErrorAt(_, _) => return Err(self.error.take().unwrap()),
                _ => {}
            }
        }
        let want = buf.len().min(self.max_read);
        self.cursor.read(&mut buf[..want])
    }
}
impl Seek for Spy<'_> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.seeks.set(self.seeks.get() + 1);
        let result = self.cursor.seek(pos);
        self.in_payload =
            matches!(pos, SeekFrom::Start(p) if self.payloads.iter().any(|range| range.start == p));
        if matches!(self.trigger, Trigger::Seek(n) if self.seeks.get() == n) {
            self.fired.set(true);
            self.token.store(true, SeqCst);
        }
        result
    }
}
impl Drop for Spy<'_> {
    fn drop(&mut self) {
        self.drops.set(self.drops.get() + 1);
    }
}

static DISPLAY: AtomicUsize = AtomicUsize::new(0);
static DEBUG: AtomicUsize = AtomicUsize::new(0);
static SOURCE: AtomicUsize = AtomicUsize::new(0);
static ERROR_DROP: AtomicUsize = AtomicUsize::new(0);
struct CallerError(Vec<u8>);
impl fmt::Display for CallerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        DISPLAY.fetch_add(1, SeqCst);
        f.write_str("caller error")
    }
}
impl fmt::Debug for CallerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        DEBUG.fetch_add(1, SeqCst);
        f.write_str("caller debug")
    }
}
impl Error for CallerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        SOURCE.fetch_add(1, SeqCst);
        None
    }
}
impl Drop for CallerError {
    fn drop(&mut self) {
        std::hint::black_box(self.0.len());
        ERROR_DROP.fetch_add(1, SeqCst);
    }
}

fn measured(
    fixture: &Fixture,
    trigger: Trigger,
    initial: bool,
    expected: Option<&str>,
    max_read: usize,
) -> (usize, usize) {
    let token = AtomicBool::new(initial);
    let (reads, seeks, drops, later, fired) = (
        Cell::new(0),
        Cell::new(0),
        Cell::new(0),
        Cell::new(0),
        Cell::new(false),
    );
    // Arbitrary error owns 128KiB before measurement. No formatter/source hook
    // is allowed to run, even when the token races the error return.
    let error = matches!(trigger, Trigger::ErrorAt(_, _))
        .then(|| io::Error::other(CallerError(vec![0; 128 * 1024])));
    let bounds = fees(fixture);
    begin();
    let result = inspect_package_identity_with_limits_and_cancel(
        Spy {
            cursor: Cursor::new(&fixture.bytes),
            token: &token,
            trigger,
            reads: &reads,
            seeks: &seeks,
            drops: &drops,
            later_reads: &later,
            fired: &fired,
            max_read,
            error,
            payloads: &fixture.payloads,
            in_payload: false,
        },
        quotas(),
        &token,
    );
    let retained = LIVE.load(SeqCst);
    let code = result.as_ref().err().map(|error| error.code);
    let actual_fee = result
        .as_ref()
        .ok()
        .map(|identity| identity.retained_identity_requested_bytes().unwrap());
    let observation = end();
    drop(result);
    assert_eq!(code, expected, "read={} seek={}", reads.get(), seeks.get());
    assert_eq!(drops.get(), 1);
    assert_eq!(LIVE.load(SeqCst), 0, "{observation:?}");
    assert!(
        observation.peak as u64 <= bounds.workspace_requested_bytes(),
        "{observation:?}"
    );
    if let Some(fee) = actual_fee {
        assert!(retained as u64 <= fee);
    }
    let payload_trigger = match trigger {
        Trigger::At(p) | Trigger::EofAt(p) | Trigger::InterruptedAt(p) => {
            fixture.payloads.iter().any(|range| range.contains(&p))
        }
        _ => false,
    };
    if expected == Some("cancelled") && fired.get() && payload_trigger {
        assert_eq!(later.get(), 0, "payload continued after cancellation");
    }
    if initial {
        assert_eq!((reads.get(), seeks.get()), (0, 0));
    }
    println!("identity code={code:?} peak={} retained={retained} requests={} largest={} raw_growth={} reads={} seeks={} after_drop=0",
        observation.peak, observation.requests, observation.largest, observation.raw_growth, reads.get(), seeks.get());
    (reads.get(), seeks.get())
}

#[test]
fn canonical_identity_envelope_and_bottom_cancellation() {
    let executable = std::env::current_exe().unwrap();
    let cold = Command::new(executable)
        .args([
            "--exact",
            "cold_preopening_query_does_not_initialize_catalog",
            "--nocapture",
        ])
        .env("HERTZ_CANONICAL_HEAP_COLD", "1")
        .output()
        .unwrap();
    assert!(
        cold.status.success(),
        "{}{}",
        String::from_utf8_lossy(&cold.stdout),
        String::from_utf8_lossy(&cold.stderr)
    );
    print!("{}", String::from_utf8_lossy(&cold.stdout));
    hertz_wallpaper::catalog();

    begin();
    let bounds =
        CanonicalIdentityHeapBounds::for_package_bytes::<Cursor<&[u8]>>(MAX_PACKAGE_BYTES, None)
            .unwrap();
    let query = end();
    assert_eq!((query.requests, query.peak, query.retained), (0, 0, 0));
    let mut limits = quotas();
    limits.max_raw_entries = usize::MAX;
    limits.max_variable_bytes = usize::MAX;
    limits.max_zip64_extensible_bytes = usize::MAX;
    limits.max_eocd_comment_bytes = usize::MAX;
    let capped =
        CanonicalIdentityHeapBounds::for_package_bytes::<Cursor<&[u8]>>(1234, Some(limits))
            .unwrap();
    assert_eq!(
        capped.effective_metadata_limits(),
        MetadataLimits {
            max_raw_entries: 2056,
            max_variable_bytes: 1234,
            max_zip64_extensible_bytes: 1234,
            max_eocd_comment_bytes: 65535
        }
    );
    assert_eq!(bounds.raw_manifest_retained_requested_bytes(), 524288);
    assert_eq!(bounds.raw_manifest_growth_requested_bytes(), 786432);
    assert_eq!(
        bounds.entry_verification_workspace_requested_bytes(),
        2332357
    );
    assert_eq!(bounds.retained_identity_requested_bytes(), 9517723);
    assert_eq!(
        bounds.workspace_requested_bytes(),
        *bounds.phase_requested_bytes().iter().max().unwrap()
    );
    assert_eq!(
        bounds.workspace_with_live_base(1).unwrap(),
        bounds.workspace_requested_bytes() + 1
    );
    assert_eq!(
        bounds.workspace_with_live_base(u64::MAX).unwrap_err().code,
        "canonical_identity_heap_limit"
    );
    assert_eq!(
        CanonicalIdentityHeapBounds::for_package_bytes::<Cursor<&[u8]>>(
            MAX_PACKAGE_BYTES + 1,
            None
        )
        .unwrap_err()
        .code,
        "package_too_large"
    );
    println!("bounds max={bounds:?}");

    for deflate in [false, true] {
        let fixture = fixture(deflate);
        measured(&fixture, Trigger::Never, false, None, usize::MAX);
        measured(
            &fixture,
            Trigger::Never,
            true,
            Some("cancelled"),
            usize::MAX,
        );
        measured(
            &fixture,
            Trigger::Seek(1),
            false,
            Some("cancelled"),
            usize::MAX,
        );
        measured(
            &fixture,
            Trigger::Seek(2),
            false,
            Some("cancelled"),
            usize::MAX,
        );
        // Cancel once constructor's first underlying metadata read returns.
        measured(
            &fixture,
            Trigger::Read(1),
            false,
            Some("cancelled"),
            usize::MAX,
        );
        // Manifest by_index local-header operation returns before cancellation.
        measured(
            &fixture,
            Trigger::At(fixture.headers[0]),
            false,
            Some("cancelled"),
            usize::MAX,
        );
        for target in [
            fixture.payloads[0].start,
            fixture.payloads[1].start,
            fixture.payloads[2].start,
        ] {
            for trigger in [
                Trigger::At(target),
                Trigger::EofAt(target),
                Trigger::InterruptedAt(target),
            ] {
                measured(&fixture, trigger, false, Some("cancelled"), usize::MAX);
            }
            for race in [false, true] {
                measured(
                    &fixture,
                    Trigger::ErrorAt(target, race),
                    false,
                    Some("format_unsupported"),
                    usize::MAX,
                );
            }
        }
        // Resource by_index local-header return, and the final resource's last
        // successful read, must not produce a returned identity seal.
        measured(
            &fixture,
            Trigger::At(fixture.headers[1]),
            false,
            Some("cancelled"),
            usize::MAX,
        );
        measured(
            &fixture,
            Trigger::At(fixture.payloads[2].end - 1),
            false,
            Some("cancelled"),
            1,
        );
    }
    assert_eq!(
        (
            DISPLAY.load(SeqCst),
            DEBUG.load(SeqCst),
            SOURCE.load(SeqCst)
        ),
        (0, 0, 0)
    );
    assert_eq!(ERROR_DROP.load(SeqCst), 12);

    // Successful MAX and forged declared MAX with real MAX+1 use the ORIGINAL
    // owner. Whitespace padding leaves a valid manifest and exact original len.
    let resource = Entry::stored(b"a.bin", b"abc");
    for deflate in [false, true] {
        for n in [MAX_MANIFEST_BYTES, MAX_MANIFEST_BYTES + 1] {
            let mut raw = manifest(std::slice::from_ref(&resource));
            raw.resize(n, b' ');
            let mut m = if deflate {
                Entry::zero_output_deflate(b"manifest.json", &raw)
            } else {
                Entry::stored(b"manifest.json", &raw)
            };
            m.decoded = MAX_MANIFEST_BYTES;
            let fixture = package(&[m, resource.clone()]);
            measured(
                &fixture,
                Trigger::Never,
                false,
                if n > MAX_MANIFEST_BYTES {
                    Some("manifest_too_large")
                } else {
                    None
                },
                usize::MAX,
            );
            if !deflate {
                assert_eq!(RAW_GROWTH.load(SeqCst), usize::from(n > MAX_MANIFEST_BYTES));
            }
        }
    }

    // A bottom EOF after real successful resource data also cancels before
    // CRC/hash/EOF success can be accepted. A padding byte gives Take room to
    // reach the injected EOF; its central declaration still authorizes3 bytes.
    let canonical = Entry::stored(b"a.bin", b"abc");
    let raw = manifest(std::slice::from_ref(&canonical));
    let mut with_padding = canonical.clone();
    with_padding.compressed.push(0);
    let eof_fixture = package(&[Entry::stored(b"manifest.json", &raw), with_padding]);
    measured(
        &eof_fixture,
        Trigger::EofAt(eof_fixture.payloads[1].start + 3),
        false,
        Some("cancelled"),
        3,
    );

    // Full canonical file count exercises original std HashSet and verified
    // Vec growth at the independently proven source layouts (24/16/80).
    let resources: Vec<_> = (0..MAX_FILES)
        .map(|i| Entry::stored(format!("f{i}").as_bytes(), b"x"))
        .collect();
    let raw = manifest(&resources);
    assert!(raw.len() <= MAX_MANIFEST_BYTES);
    let mut entries = vec![Entry::stored(b"manifest.json", &raw)];
    entries.extend(resources);
    let many = package(&entries);
    measured(&many, Trigger::Never, false, None, usize::MAX);
    assert!(LOWER_TABLE.load(SeqCst) > 0);
    assert!(DECLARED_TABLE.load(SeqCst) > 0);

    // Before the 180-byte rule, both original raw name copies can reach65535.
    // Compressed-range diagnostics use the different ZIP-decoded CP437 name.
    for (utf8, escaping, expected) in [
        (true, false, "invalid_path"),
        (false, true, "invalid_compressed_range"),
    ] {
        // D6 B0 is valid UTF8, while EACH byte decodes to a 3-byte CP437
        // box glyph. Raw UTF8 conversion must succeed before range checking.
        let raw_name = if utf8 {
            vec![b'a'; 65535]
        } else {
            [0xd6, 0xb0].repeat(32767)
        };
        let mut long = Entry::stored(&raw_name, b"");
        long.utf8 = utf8;
        long.escaping_range = escaping;
        let empty = manifest(&[]);
        let fixture = package(&[Entry::stored(b"manifest.json", &empty), long]);
        measured(&fixture, Trigger::Never, false, Some(expected), usize::MAX);
        if !utf8 {
            assert!(LARGEST.load(SeqCst) >= 196602);
        }
    }
    // Identity always verifies the unselected tail: an undeclared entry cannot
    // be hidden by any downstream selected model or source/variant binding.
    let undeclared = package(&[
        Entry::stored(b"manifest.json", &manifest(&[])),
        Entry::stored(b"tail", b"x"),
    ]);
    measured(
        &undeclared,
        Trigger::Never,
        false,
        Some("undeclared_file"),
        usize::MAX,
    );

    // Legacy Interrupted distinction at the two original API owners.
    for (manifest_read, expected) in [(true, None), (false, Some("format_unsupported"))] {
        let fixture = fixture(false);
        let target = fixture.payloads[usize::from(!manifest_read)].start;
        let token = AtomicBool::new(false);
        let (reads, seeks, drops, later, fired) = (
            Cell::new(0),
            Cell::new(0),
            Cell::new(0),
            Cell::new(0),
            Cell::new(false),
        );
        let reader = Spy {
            cursor: Cursor::new(&fixture.bytes),
            token: &token,
            trigger: Trigger::ErrorAt(target, false),
            reads: &reads,
            seeks: &seeks,
            drops: &drops,
            later_reads: &later,
            fired: &fired,
            max_read: usize::MAX,
            error: Some(io::ErrorKind::Interrupted.into()),
            payloads: &fixture.payloads,
            in_payload: false,
        };
        let result = inspect_package_identity(reader);
        assert_eq!(result.err().map(|error| error.code), expected);
        assert_eq!(drops.get(), 1);
    }

    // Checked pre-opening/post-opening read fees are the same concrete factor,
    // including borrowed plaintext token changes. No guessed freeze is used.
    let fixture = fixture(true);
    let bounds = fees(&fixture);
    let limits = bounds.effective_metadata_limits();
    let archive =
        ZipArchive::with_metadata_limits(Default::default(), Cursor::new(&fixture.bytes), limits)
            .unwrap();
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        let before = limits
            .checked_read_heap_bounds::<Cursor<&[u8]>>(method)
            .unwrap();
        let after = archive.checked_metadata_read_heap_bounds(method).unwrap();
        assert_eq!(
            before.additional_reader_bytes,
            after.additional_reader_bytes
        );
        println!("current concrete method={method:?} before={before:?} actual={after:?}");
    }
}

#[test]
fn cold_preopening_query_does_not_initialize_catalog() {
    if std::env::var_os("HERTZ_CANONICAL_HEAP_COLD").is_none() {
        return;
    }
    begin();
    let fees = CanonicalIdentityHeapBounds::for_package_bytes::<Cursor<&[u8]>>(0, None).unwrap();
    let query = end();
    assert_eq!((query.requests, query.peak, query.retained), (0, 0, 0));
    begin();
    std::hint::black_box(hertz_wallpaper::catalog());
    let catalog = end();
    assert!(catalog.requests > 0, "query initialized catalog");
    assert!(catalog.peak as u64 <= fees.catalog_cold_requested_bytes());
    assert!(catalog.retained as u64 <= fees.catalog_retained_requested_bytes());
    println!("cold child query={query:?} catalog={catalog:?}");
}
