//! Small real-parser fixtures and requested-allocation falsifiers.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use zip::read::{Config, MetadataLimits};
use zip::result::ZipError;
use zip::{CompressionMethod, ZipArchive};

struct ObservedAllocator;
static TRACK: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static MAX: AtomicUsize = AtomicUsize::new(0);
static REALLOCS: AtomicUsize = AtomicUsize::new(0);
static POINTERS: [AtomicUsize; 8192] = [const { AtomicUsize::new(0) }; 8192];
static SIZES: [AtomicUsize; 8192] = [const { AtomicUsize::new(0) }; 8192];

fn charge(size: usize) {
    let current = LIVE.fetch_add(size, SeqCst) + size;
    PEAK.fetch_max(current, SeqCst);
    MAX.fetch_max(size, SeqCst);
}
fn record(pointer: *mut u8, size: usize) {
    if pointer.is_null() || !TRACK.load(SeqCst) {
        return;
    }
    charge(size);
    for slot in 0..POINTERS.len() {
        if POINTERS[slot]
            .compare_exchange(0, pointer as usize, SeqCst, SeqCst)
            .is_ok()
        {
            SIZES[slot].store(size, SeqCst);
            return;
        }
    }
    std::process::abort();
}
fn forget(pointer: *mut u8) -> Option<(usize, usize)> {
    for slot in 0..POINTERS.len() {
        if POINTERS[slot].load(SeqCst) == pointer as usize {
            let size = SIZES[slot].swap(0, SeqCst);
            POINTERS[slot].store(0, SeqCst);
            LIVE.fetch_sub(size, SeqCst);
            return Some((slot, size));
        }
    }
    None
}
unsafe impl GlobalAlloc for ObservedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        record(pointer, layout.size());
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc_zeroed(layout);
        record(pointer, layout.size());
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        forget(pointer);
        System.dealloc(pointer, layout);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let tracked = POINTERS
            .iter()
            .any(|slot| slot.load(SeqCst) == pointer as usize);
        // Include both old and new requests before observing allocator movement.
        if tracked {
            charge(size);
            REALLOCS.fetch_add(1, SeqCst);
        }
        let new = System.realloc(pointer, layout, size);
        if tracked {
            LIVE.fetch_sub(size, SeqCst);
            if !new.is_null() {
                forget(pointer);
                record(new, size);
            }
        } else {
            record(new, size);
        }
        new
    }
}
#[global_allocator]
static ALLOCATOR: ObservedAllocator = ObservedAllocator;

fn begin() {
    assert_eq!(LIVE.load(SeqCst), 0);
    MAX.store(0, SeqCst);
    PEAK.store(0, SeqCst);
    REALLOCS.store(0, SeqCst);
    TRACK.store(true, SeqCst);
}
fn end() -> (usize, usize, usize, usize) {
    TRACK.store(false, SeqCst);
    (
        PEAK.load(SeqCst),
        LIVE.load(SeqCst),
        MAX.load(SeqCst),
        REALLOCS.load(SeqCst),
    )
}

#[derive(Clone)]
struct Record {
    name: Vec<u8>,
    extra: Vec<u8>,
    comment: Vec<u8>,
    utf8: bool,
}
fn record_named(name: &[u8]) -> Record {
    Record {
        name: name.to_vec(),
        extra: Vec::new(),
        comment: Vec::new(),
        utf8: false,
    }
}
fn u16_at(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn u32_at(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn u64_at(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}
fn local(payload: u32, deflate: bool) -> Vec<u8> {
    let mut bytes = vec![0; 31];
    u32_at(&mut bytes, 0, 0x04034b50);
    u16_at(&mut bytes, 4, 20);
    u16_at(&mut bytes, 8, if deflate { 8 } else { 0 });
    u32_at(&mut bytes, 18, payload);
    u16_at(&mut bytes, 26, 1);
    bytes[30] = b'a';
    bytes
}
fn directory(
    records: &[Record],
    start: u32,
    payload: u32,
    comment: &[u8],
    deflate: bool,
) -> Vec<u8> {
    let mut bytes = Vec::new();
    for record in records {
        let mut block = [0; 46];
        u32_at(&mut block, 0, 0x02014b50);
        u16_at(&mut block, 4, 20);
        u16_at(&mut block, 6, 20);
        u16_at(&mut block, 8, if record.utf8 { 1 << 11 } else { 0 });
        u16_at(&mut block, 10, if deflate { 8 } else { 0 });
        u32_at(&mut block, 20, payload);
        u16_at(&mut block, 28, record.name.len() as u16);
        u16_at(&mut block, 30, record.extra.len() as u16);
        u16_at(&mut block, 32, record.comment.len() as u16);
        bytes.extend_from_slice(&block);
        bytes.extend_from_slice(&record.name);
        bytes.extend_from_slice(&record.extra);
        bytes.extend_from_slice(&record.comment);
    }
    let size = bytes.len();
    let mut eocd = [0; 22];
    u32_at(&mut eocd, 0, 0x06054b50);
    u16_at(&mut eocd, 8, records.len() as u16);
    u16_at(&mut eocd, 10, records.len() as u16);
    u32_at(&mut eocd, 12, size as u32);
    u32_at(&mut eocd, 16, start);
    u16_at(&mut eocd, 20, comment.len() as u16);
    bytes.extend_from_slice(&eocd);
    bytes.extend_from_slice(comment);
    bytes
}
fn fixture(records: &[Record], comment: &[u8]) -> Vec<u8> {
    let mut bytes = local(0, false);
    bytes.extend_from_slice(&directory(records, bytes.len() as u32, 0, comment, false));
    bytes
}
fn zip64(records: &[Record], x: &[u8], real_count: u64) -> Vec<u8> {
    let mut bytes = fixture(records, b"end");
    let eocd_start = bytes.len() - 25;
    let directory_size = eocd_start - 31;
    let eocd = bytes.split_off(eocd_start);
    let mut block = [0; 56];
    u32_at(&mut block, 0, 0x06064b50);
    u64_at(&mut block, 4, 44 + x.len() as u64);
    u16_at(&mut block, 12, 45);
    u16_at(&mut block, 14, 45);
    u64_at(&mut block, 24, real_count);
    u64_at(&mut block, 32, real_count);
    u64_at(&mut block, 40, directory_size as u64);
    u64_at(&mut block, 48, 31);
    bytes.extend_from_slice(&block);
    bytes.extend_from_slice(x);
    let mut locator = [0; 20];
    u32_at(&mut locator, 0, 0x07064b50);
    u64_at(&mut locator, 8, eocd_start as u64);
    u32_at(&mut locator, 16, 1);
    bytes.extend_from_slice(&locator);
    let offset = bytes.len();
    bytes.extend_from_slice(&eocd);
    u16_at(&mut bytes, offset + 8, u16::MAX);
    u16_at(&mut bytes, offset + 10, u16::MAX);
    u32_at(&mut bytes, offset + 16, u32::MAX);
    bytes
}
fn limits(records: &[Record], x: usize, comment: usize) -> MetadataLimits {
    MetadataLimits {
        max_raw_entries: records.len(),
        max_variable_bytes: records
            .iter()
            .map(|r| r.name.len() + r.extra.len() + r.comment.len())
            .sum(),
        max_zip64_extensible_bytes: x,
        max_eocd_comment_bytes: comment,
    }
}

struct Spy<'a> {
    prefix: &'a [u8],
    tail: &'a [u8],
    tail_start: u64,
    position: u64,
    bytes: &'a Cell<usize>,
    denied_read: Option<(u64, usize)>,
    forbidden_hit: &'a Cell<bool>,
    fail_at: Option<u64>,
}
impl Read for Spy<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.denied_read == Some((self.position, buffer.len())) {
            self.forbidden_hit.set(true);
        }
        if self.fail_at == Some(self.position) {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let file_len = self.tail_start + self.tail.len() as u64;
        let take = buffer
            .len()
            .min(file_len.saturating_sub(self.position) as usize);
        buffer[..take].fill(0);
        for (i, byte) in buffer[..take].iter_mut().enumerate() {
            let pos = self.position + i as u64;
            if let Some(value) = self.prefix.get(pos as usize) {
                *byte = *value;
            } else if pos >= self.tail_start {
                *byte = self.tail[(pos - self.tail_start) as usize];
            }
        }
        self.position += take as u64;
        self.bytes.set(self.bytes.get() + take);
        Ok(take)
    }
}
impl Seek for Spy<'_> {
    fn seek(&mut self, seek: SeekFrom) -> io::Result<u64> {
        self.position = match seek {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(n) => self.position.checked_add_signed(n),
            SeekFrom::End(n) => (self.tail_start + self.tail.len() as u64).checked_add_signed(n),
        }
        .ok_or(io::ErrorKind::InvalidInput)?;
        Ok(self.position)
    }
}

fn observed(
    bytes: &[u8],
    limit: MetadataLimits,
    success: bool,
    quota: Option<&str>,
) -> (usize, usize, usize) {
    begin();
    let result = ZipArchive::with_metadata_limits(Config::default(), Cursor::new(bytes), limit);
    let (peak, live, largest, reallocs) = end();
    assert_eq!(result.is_ok(), success, "result={result:?}");
    if let Some(reason) = quota {
        assert!(
            matches!(&result, Err(ZipError::MetadataLimitExceeded(r)) if *r == reason),
            "result={result:?}"
        );
    }
    let bound = limit.checked_heap_bounds().unwrap();
    assert!(peak <= bound.opening_peak_bytes, "peak {peak} > {bound:?}");
    if let Ok(archive) = &result {
        assert!(
            live <= archive
                .checked_metadata_heap_bounds()
                .unwrap()
                .retained_metadata_bytes
        );
    }
    assert_eq!(
        reallocs, 0,
        "bounded owner must not use hidden amortized reallocations"
    );
    drop(result);
    assert_eq!(LIVE.load(SeqCst), 0, "partial/success owner cleanup");
    (peak, live, largest)
}

fn unicode(kind: u16, original: &[u8], content: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&kind.to_le_bytes());
    bytes.extend_from_slice(&((5 + content.len()) as u16).to_le_bytes());
    bytes.push(1);
    bytes.extend_from_slice(&crc32fast::hash(original).to_le_bytes());
    bytes.extend_from_slice(content);
    bytes
}

#[test]
fn bounded_parser_allocator_and_read_contract() {
    let one = [record_named(b"a")];
    let exact = fixture(&one, b"end");
    let exact_limits = limits(&one, 0, 3);
    println!("exact {:?}", observed(&exact, exact_limits, true, None));
    for (field, reason) in [
        (0, "raw entry limit exceeded"),
        (1, "central variable byte limit exceeded"),
        (2, "EOCD comment limit exceeded"),
    ] {
        let mut limit = exact_limits;
        match field {
            0 => limit.max_raw_entries = 0,
            1 => limit.max_variable_bytes = 0,
            _ => limit.max_eocd_comment_bytes = 2,
        }
        observed(&exact, limit, false, Some(reason));
    }
    let mut huge = exact.clone();
    let eocd = huge.len() - 25;
    u16_at(&mut huge, eocd + 8, 60000);
    u16_at(&mut huge, eocd + 10, 60000);
    assert!(observed(&huge, exact_limits, false, Some("raw entry limit exceeded")).2 <= 2048);
    let mut lying_count = exact.clone();
    u16_at(&mut lying_count, eocd + 8, 300);
    u16_at(&mut lying_count, eocd + 10, 300);
    let mut permissive = exact_limits;
    permissive.max_raw_entries = 300;
    assert!(observed(&lying_count, permissive, false, None).2 <= 4096);

    let z64 = zip64(&one, b"sector", 1);
    let z64_limits = limits(&one, 6, 3);
    observed(&z64, z64_limits, true, None);
    let mut small_x = z64_limits;
    small_x.max_zip64_extensible_bytes = 5;
    observed(
        &z64,
        small_x,
        false,
        Some("ZIP64 extensible byte limit exceeded"),
    );
    let z64_huge = zip64(&one, b"sector", u64::MAX);
    assert!(
        observed(
            &z64_huge,
            z64_limits,
            false,
            Some("raw entry limit exceeded")
        )
        .2 <= 2048
    );
    let bytes_read = Cell::new(0);
    let hit = Cell::new(false);
    let sector_at = (z64.len() - 25 - 20 - 6) as u64;
    let spy = Spy {
        prefix: &z64,
        tail: &[],
        tail_start: z64.len() as u64,
        position: 0,
        bytes: &bytes_read,
        denied_read: Some((sector_at, 6)),
        forbidden_hit: &hit,
        fail_at: None,
    };
    assert!(matches!(
        ZipArchive::with_metadata_limits(Config::default(), spy, small_x),
        Err(ZipError::MetadataLimitExceeded(_))
    ));
    assert!(!hit.get(), "sector reject must precede its Read");

    // A later fake candidate's quota cannot be swallowed in favor of an earlier valid archive.
    let mut fallback = exact.clone();
    fallback.extend_from_slice(&huge[eocd..]);
    observed(
        &fallback,
        exact_limits,
        false,
        Some("raw entry limit exceeded"),
    );

    // Raw central variables are guarded before their own allocation/read.
    let mut large_name = record_named(&[b'n'; 100]);
    large_name.comment = vec![b'c'; 71];
    let large_records = [large_name];
    let large = fixture(&large_records, b"");
    let mut too_small = limits(&large_records, 0, 0);
    too_small.max_variable_bytes -= 1;
    let bytes_read = Cell::new(0);
    let hit = Cell::new(false);
    let spy = Spy {
        prefix: &large,
        tail: &[],
        tail_start: large.len() as u64,
        position: 0,
        bytes: &bytes_read,
        denied_read: Some((77, 100)),
        forbidden_hit: &hit,
        fail_at: None,
    };
    assert!(matches!(
        ZipArchive::with_metadata_limits(Config::default(), spy, too_small),
        Err(ZipError::MetadataLimitExceeded(_))
    ));
    assert!(!hit.get());
    let mut short_directory = large.clone();
    let footer = short_directory.len() - 22;
    u32_at(&mut short_directory, footer + 12, 46);
    observed(&short_directory, limits(&large_records, 0, 0), false, None);

    for extra in [
        vec![0xff, 0xff, 0xff, 0xff],
        vec![0x55, 0x54, 1, 0, 1],
        vec![0x75, 0x70, 0xff, 0xff],
        vec![1, 0, 1, 0, 0],
    ] {
        let mut bad = record_named(b"a");
        bad.extra = extra;
        let records = [bad];
        let bytes = fixture(&records, b"");
        // Every error/success path must clean up all partial owners.
        begin();
        let result = ZipArchive::with_metadata_limits(
            Config::default(),
            Cursor::new(&bytes),
            limits(&records, 0, 0),
        );
        let measurements = end();
        assert!(
            measurements.0
                <= limits(&records, 0, 0)
                    .checked_heap_bounds()
                    .unwrap()
                    .opening_peak_bytes
        );
        assert_eq!(measurements.3, 0);
        drop(result);
        assert_eq!(LIVE.load(SeqCst), 0);
    }
    for extra in [
        vec![0x55, 0x54, 1, 0, 1],
        vec![0x75, 0x70, 0, 0],
        vec![0x0a, 0, 32, 0, 0],
    ] {
        let mut record = record_named(b"a");
        record.extra = extra;
        let records = [record];
        let bytes = fixture(&records, b"");
        observed(&bytes, limits(&records, 0, 0), false, None);
    }

    for raw in [
        vec![0x80, 0xcc, 0xff, b'a'],
        vec![0xf0, 0x80, 0x80, 0xff, 0xe2, 0x82],
        (0..=255).collect::<Vec<u8>>(),
    ] {
        for utf8 in [false, true] {
            let mut record = record_named(&raw);
            record.utf8 = utf8;
            record.comment = raw.clone();
            let records = [record];
            let bytes = fixture(&records, b"");
            let mut original = ZipArchive::new(Cursor::new(&bytes)).unwrap();
            let mut bounded = ZipArchive::with_metadata_limits(
                Config::default(),
                Cursor::new(&bytes),
                limits(&records, 0, 0),
            )
            .unwrap();
            let original = original.by_index(0).unwrap();
            let bounded = bounded.by_index(0).unwrap();
            assert_eq!(original.name(), bounded.name());
            assert_eq!(original.comment(), bounded.comment());
            drop(original);
            drop(bounded);
            observed(&bytes, limits(&records, 0, 0), true, None);
        }
    }
    // Replacement buffers coexist with original/processed extra owners.
    let mut unicode_record = record_named(b"a");
    unicode_record.comment = b"c".to_vec();
    unicode_record.extra = unicode(0x7075, b"a", "路径".as_bytes());
    unicode_record.extra.extend_from_slice(&unicode(
        0x7075,
        "路径".as_bytes(),
        "替代路径".as_bytes(),
    ));
    unicode_record
        .extra
        .extend_from_slice(&unicode(0x6375, b"c", "注释".as_bytes()));
    unicode_record.extra.extend_from_slice(&unicode(
        0x6375,
        "注释".as_bytes(),
        "替代注释".as_bytes(),
    ));
    for _ in 0..20 {
        unicode_record
            .extra
            .extend_from_slice(&[0x55, 0x54, 1, 0, 0]);
    }
    for _ in 0..3 {
        unicode_record.extra.extend_from_slice(&[1, 0, 0, 0]);
    }
    let records = [unicode_record];
    let bytes = fixture(&records, b"");
    let mut archive = ZipArchive::with_metadata_limits(
        Config::default(),
        Cursor::new(&bytes),
        limits(&records, 0, 0),
    )
    .unwrap();
    let file = archive.by_index(0).unwrap();
    assert_eq!(file.name(), "替代路径");
    assert_eq!(file.comment(), "替代注释");
    assert_eq!(file.extra_data_fields().count(), 20);
    drop(file);
    drop(archive);
    println!(
        "unicode+typed+removed {:?}",
        observed(&bytes, limits(&records, 0, 0), true, None)
    );
    let mut corrupt = bytes.clone();
    corrupt[77 + 1 + 5] ^= 1;
    observed(&corrupt, limits(&records, 0, 0), false, None);

    for count in [1, 2, 3, 4, 7, 8, 14, 15, 28, 29, 100] {
        let records: Vec<_> = (0..count)
            .map(|i| record_named(format!("n{i}").as_bytes()))
            .collect();
        let bytes = fixture(&records, b"end");
        println!(
            "shared count={count} {:?}",
            observed(&bytes, limits(&records, 0, 3), true, None)
        );
    }
    let dup = [record_named(b"a"), record_named(b"a")];
    let bytes = fixture(&dup, b"");
    let mut underreported = bytes.clone();
    let footer = underreported.len() - 22;
    u16_at(&mut underreported, footer + 8, 1);
    u16_at(&mut underreported, footer + 10, 1);
    observed(&underreported, limits(&dup, 0, 0), false, None);
    assert_eq!(
        ZipArchive::new(Cursor::new(&underreported))
            .unwrap()
            .raw_file_count(),
        1
    );
    let mut underreported_size = underreported.clone();
    u32_at(&mut underreported_size, footer + 12, 47);
    observed(&underreported_size, limits(&dup, 0, 0), false, None);
    let mut signed = exact.clone();
    let footer = signed.len() - 25;
    let footer_bytes = signed.split_off(footer);
    signed.extend_from_slice(&[0x50, 0x4b, 0x05, 0x05, 3, 0, 1, 2, 3]);
    let footer = signed.len();
    signed.extend_from_slice(&footer_bytes);
    u32_at(&mut signed, footer + 12, 47 + 9);
    observed(&signed, exact_limits, true, None);
    u32_at(&mut signed, footer + 12, 47);
    observed(&signed, exact_limits, true, None);
    let archive = ZipArchive::with_metadata_limits(
        Config::default(),
        Cursor::new(&bytes),
        limits(&dup, 0, 0),
    )
    .unwrap();
    assert_eq!(archive.raw_file_count(), 2);
    assert_eq!(archive.len(), 1);
    assert_eq!(archive.metadata_usage().variable_bytes(), 2);
    let default = ZipArchive::new(Cursor::new(&bytes)).unwrap();
    assert_eq!(default.raw_file_count(), 2);
    assert_eq!(default.len(), 1);
    observed(&bytes, limits(&dup, 0, 0), true, None);
    // Last value wins, including differently encoded names that decode to the same key.
    let mut first = record_named(&[0x82]);
    first.comment = b"first".to_vec();
    let mut last = record_named("é".as_bytes());
    last.utf8 = true;
    last.comment = b"last".to_vec();
    let records = [first, last];
    let bytes = fixture(&records, b"");
    let mut archive = ZipArchive::with_metadata_limits(
        Config::default(),
        Cursor::new(&bytes),
        limits(&records, 0, 0),
    )
    .unwrap();
    assert_eq!(archive.raw_file_count(), 2);
    assert_eq!(archive.len(), 1);
    assert_eq!(archive.by_index(0).unwrap().comment(), "last");

    // Failure after a complete first record and a partially allocated second record.
    let records = [record_named(b"first"), record_named(b"second")];
    let bytes = fixture(&records, b"");
    let second_name = 31 + 46 + 5 + 46;
    let bytes_read = Cell::new(0);
    let hit = Cell::new(false);
    let spy = Spy {
        prefix: &bytes,
        tail: &[],
        tail_start: bytes.len() as u64,
        position: 0,
        bytes: &bytes_read,
        denied_read: None,
        forbidden_hit: &hit,
        fail_at: Some(second_name),
    };
    begin();
    let result = ZipArchive::with_metadata_limits(Config::default(), spy, limits(&records, 0, 0));
    let measures = end();
    assert!(result.is_err());
    assert!(
        measures.0
            <= limits(&records, 0, 0)
                .checked_heap_bounds()
                .unwrap()
                .opening_peak_bytes
    );
    drop(result);
    assert_eq!(LIVE.load(SeqCst), 0);

    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "a",
            zip::write::SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
    writer.write_all(b"data").unwrap();
    let writer_archive = writer.finish_into_readable().unwrap();
    assert_eq!(writer_archive.raw_file_count(), 1);
    assert_eq!(writer_archive.metadata_usage().variable_bytes(), 1);
    assert!(!writer_archive.metadata_usage().is_bounded());

    for payload in [0, 256 * 1024 * 1024] {
        let records = [record_named(b"a"), record_named(b"b")];
        let prefix = local(payload, false);
        let tail_start = prefix.len() as u64 + payload as u64;
        let tail = directory(&records, tail_start as u32, payload, b"", false);
        let bytes_read = Cell::new(0);
        let hit = Cell::new(false);
        let spy = Spy {
            prefix: &prefix,
            tail: &tail,
            tail_start,
            position: 0,
            bytes: &bytes_read,
            denied_read: None,
            forbidden_hit: &hit,
            fail_at: None,
        };
        begin();
        let archive =
            ZipArchive::with_metadata_limits(Config::default(), spy, limits(&records, 0, 0))
                .unwrap();
        let measures = end();
        assert!(
            measures.0
                <= archive
                    .checked_metadata_heap_bounds()
                    .unwrap()
                    .opening_peak_bytes
        );
        assert!(measures.2 < 8192);
        assert!(bytes_read.get() < 4096);
        println!(
            "virtual payload={payload} read={} peak={} live={}",
            bytes_read.get(),
            measures.0,
            measures.1
        );
        drop(archive);
        assert_eq!(LIVE.load(SeqCst), 0);
    }
    for deflate in [false, true] {
        #[cfg(not(feature = "deflate"))]
        if deflate {
            continue;
        }
        let mut bytes = local(if deflate { 2 } else { 0 }, deflate);
        if deflate {
            bytes.extend_from_slice(&[3, 0]);
        }
        bytes.extend_from_slice(&directory(
            &one,
            bytes.len() as u32,
            if deflate { 2 } else { 0 },
            b"",
            deflate,
        ));
        begin();
        let mut archive = ZipArchive::with_metadata_limits(
            Config::default(),
            Cursor::new(&bytes),
            limits(&one, 0, 0),
        )
        .unwrap();
        let opening = end();
        let method = if deflate {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        };
        let costs = archive.checked_metadata_read_heap_bounds(method).unwrap();
        PEAK.store(LIVE.load(SeqCst), SeqCst);
        TRACK.store(true, SeqCst);
        let mut file = archive.by_index(0).unwrap();
        let mut output = [0; 1];
        assert_eq!(file.read(&mut output).unwrap(), 0);
        let read_peak = end().0;
        assert!(
            read_peak <= costs.metadata_and_reader_bytes,
            "{read_peak} > {costs:?}"
        );
        drop(file);
        drop(archive);
        assert_eq!(LIVE.load(SeqCst), 0);
        println!(
            "reader deflate={deflate} opening={opening:?} read_peak={read_peak} costs={costs:?}"
        );
    }
    let overflow = MetadataLimits {
        max_raw_entries: usize::MAX,
        ..exact_limits
    };
    assert!(matches!(
        overflow.checked_heap_bounds(),
        Err(ZipError::MetadataLimitExceeded(_))
    ));
}
