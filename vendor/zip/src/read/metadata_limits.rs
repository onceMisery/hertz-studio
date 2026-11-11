//! Optional allocation controls for the original central-directory reader.
//!
//! Bounds cover requested heap bytes owned by this crate, excluding allocator
//! overhead and allocations made by the caller's `Read + Seek` implementation.
use crate::result::{ZipError, ZipResult};
use crate::types::ZipFileData;
use crate::ExtraField;
use std::io::Read;
use std::mem::{align_of, size_of};
use std::sync::atomic::AtomicUsize;

/// Metadata admission limits, independent of file payload sizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetadataLimits {
    /// Maximum number of raw central records, before name deduplication.
    pub max_raw_entries: usize,
    /// Sum of raw central name, extra and comment lengths, including partial records.
    pub max_variable_bytes: usize,
    /// Maximum ZIP64 extensible sector length.
    pub max_zip64_extensible_bytes: usize,
    /// Maximum EOCD comment length.
    pub max_eocd_comment_bytes: usize,
}

/// Parser-produced immutable usage; raw counts precede IndexMap deduplication.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MetadataUsage {
    pub(super) raw_entries: usize,
    pub(super) variable_bytes: usize,
    pub(super) extra_bytes: usize,
    pub(super) zip64_extensible_bytes: usize,
    pub(super) eocd_comment_bytes: usize,
    pub(super) bounded: bool,
}

impl MetadataUsage {
    /// Number of successfully parsed raw records before deduplication.
    pub fn raw_entries(&self) -> usize {
        self.raw_entries
    }
    /// Raw central names, extra fields and comments, before transformations.
    pub fn variable_bytes(&self) -> usize {
        self.variable_bytes
    }
    /// Raw central extra-field bytes.
    pub fn extra_bytes(&self) -> usize {
        self.extra_bytes
    }
    /// ZIP64 extensible sector bytes.
    pub fn zip64_extensible_bytes(&self) -> usize {
        self.zip64_extensible_bytes
    }
    /// EOCD comment bytes.
    pub fn eocd_comment_bytes(&self) -> usize {
        self.eocd_comment_bytes
    }
    /// Whether the allocation-controlled constructor produced this usage.
    pub fn is_bounded(&self) -> bool {
        self.bounded
    }
    pub(super) fn heap_bounds(&self) -> ZipResult<MetadataHeapBounds> {
        if !self.bounded {
            return Err(ZipError::UnsupportedArchive(
                "metadata allocation bounds require with_metadata_limits",
            ));
        }
        heap_bounds(
            self.raw_entries,
            self.variable_bytes,
            self.extra_bytes,
            self.zip64_extensible_bytes,
            self.eocd_comment_bytes,
        )
    }
}

/// Checked source-derived upper bounds for archive opening and retained metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetadataHeapBounds {
    /// Peak requested bytes while finding and opening the directory.
    pub opening_peak_bytes: usize,
    /// Requested bytes retained by the immutable Shared owner.
    pub retained_metadata_bytes: usize,
}

/// Additional requested bytes for one unencrypted Stored/Deflate reader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetadataReadHeapBounds {
    /// Retained metadata plus the concrete active file reader.
    pub metadata_and_reader_bytes: usize,
    /// Concrete reader's Box, input buffer and decompressor state.
    pub additional_reader_bytes: usize,
}

pub(crate) fn quota(reason: &'static str) -> ZipError {
    ZipError::MetadataLimitExceeded(reason)
}
pub(crate) fn add(a: usize, b: usize) -> ZipResult<usize> {
    a.checked_add(b)
        .ok_or_else(|| quota("metadata size arithmetic overflow"))
}
pub(crate) fn mul(a: usize, b: usize) -> ZipResult<usize> {
    a.checked_mul(b)
        .ok_or_else(|| quota("metadata size arithmetic overflow"))
}
pub(crate) fn allocation<T>(n: usize) -> ZipResult<usize> {
    let bytes = mul(n, size_of::<T>())?;
    if bytes > isize::MAX as usize {
        return Err(quota("metadata allocation layout overflow"));
    }
    Ok(bytes)
}
pub(crate) fn check(n: usize, max: usize, reason: &'static str) -> ZipResult<()> {
    if n > max {
        Err(quota(reason))
    } else {
        Ok(())
    }
}

impl MetadataLimits {
    /// Compute the opening/retained bounds before allocating or reading metadata.
    pub fn checked_heap_bounds(&self) -> ZipResult<MetadataHeapBounds> {
        heap_bounds(
            self.max_raw_entries,
            self.max_variable_bytes,
            self.max_variable_bytes,
            self.max_zip64_extensible_bytes,
            self.max_eocd_comment_bytes,
        )
    }
    /// Bound retained requested metadata and one original concrete unencrypted
    /// reader before opening anything. R's own allocations are excluded.
    /// Supports Stored and the pinned Deflate rust_backend feature closure.
    pub fn checked_read_heap_bounds<R: Read>(
        &self,
        method: crate::CompressionMethod,
    ) -> ZipResult<MetadataReadHeapBounds> {
        let additional = super::checked_reader_heap_bytes::<R>(method)?;
        let retained = self.checked_heap_bounds()?.retained_metadata_bytes;
        Ok(MetadataReadHeapBounds {
            additional_reader_bytes: additional,
            metadata_and_reader_bytes: add(retained, additional)?,
        })
    }
    pub(crate) fn entries(&self, n: u64) -> ZipResult<usize> {
        let n = usize::try_from(n).map_err(|_| quota("raw entry count does not fit usize"))?;
        check(n, self.max_raw_entries, "raw entry limit exceeded")?;
        allocation::<ZipFileData>(n)?;
        Ok(n)
    }
}

// indexmap 2.14 Bucket = { hash: usize, key: Box<str>, value: ZipFileData }.
// All fields have pointer alignment, so Rust field permutation does not change
// their total padded size. Keep a compile-time layout witness beside the owner.
#[repr(C)]
struct SourceBucket {
    hash: usize,
    key: Box<str>,
    value: ZipFileData,
}
#[repr(C)]
struct ArcLayout<T> {
    strong: AtomicUsize,
    weak: AtomicUsize,
    value: T,
}

fn table(n: usize) -> ZipResult<usize> {
    if n == 0 {
        return Ok(0);
    }
    // hashbrown 0.17 raw capacity_to_buckets. Group width is at most 16
    // on supported targets; 16 also bounds the scalar width of 8/4.
    let buckets = if n < 4 {
        4
    } else if n < 8 {
        8
    } else {
        (mul(n, 8)? / 7)
            .checked_next_power_of_two()
            .ok_or_else(|| quota("metadata hash table layout overflow"))?
    };
    let data = mul(buckets, size_of::<usize>())?;
    let aligned = add(data, 15)? & !15;
    let bytes = add(add(aligned, buckets)?, 16)?;
    if bytes > isize::MAX as usize - 15 {
        return Err(quota("metadata hash table layout overflow"));
    }
    Ok(bytes)
}

pub(super) fn map_allocation(n: usize) -> ZipResult<usize> {
    add(allocation::<SourceBucket>(n)?, table(n)?)
}

fn heap_bounds(r: usize, b: usize, e: usize, x: usize, c: usize) -> ZipResult<MetadataHeapBounds> {
    debug_assert_eq!(align_of::<SourceBucket>(), align_of::<ZipFileData>());
    let old_vec = allocation::<ZipFileData>(r)?;
    let map = map_allocation(r)?;
    let variable = allocation::<u8>(mul(8, b)?)?;
    let typed = allocation::<ExtraField>(e / 5)?;
    let arc_vec = size_of::<ArcLayout<Vec<u8>>>();
    let arc_shared = size_of::<ArcLayout<super::zip_archive::Shared>>();
    let comments = add(allocation::<u8>(x)?, allocation::<u8>(c)?)?;
    let contents = add(add(variable, typed)?, comments)?;
    let retained = add(add(add(map, contents)?, mul(r, arc_vec)?)?, arc_shared)?;
    let parse = add(add(old_vec, contents)?, mul(mul(3, r)?, arc_vec)?)?;
    // into_iter keeps old Vec backing until map construction completes. The
    // Shared Arc is made after the Vec is freed, included conservatively here.
    let conversion = add(old_vec, retained)?;
    let find = add(4096, comments)?;
    Ok(MetadataHeapBounds {
        opening_peak_bytes: find.max(parse).max(conversion),
        retained_metadata_bytes: retained,
    })
}

pub(super) struct Context {
    pub(super) limits: Option<MetadataLimits>,
    pub(super) usage: MetadataUsage,
}
impl Context {
    pub(super) fn new(limits: Option<MetadataLimits>, x: usize, c: usize) -> Self {
        Self {
            limits,
            usage: MetadataUsage {
                zip64_extensible_bytes: x,
                eocd_comment_bytes: c,
                bounded: limits.is_some(),
                ..MetadataUsage::default()
            },
        }
    }
    pub(super) fn variable(&mut self, a: usize, e: usize, c: usize) -> ZipResult<()> {
        let total = add(add(a, e)?, c)?;
        let next = add(self.usage.variable_bytes, total)?;
        if let Some(limits) = self.limits {
            check(
                next,
                limits.max_variable_bytes,
                "central variable byte limit exceeded",
            )?;
            allocation::<u8>(total)?;
            allocation::<ExtraField>(e / 5)?;
        }
        self.usage.variable_bytes = next;
        self.usage.extra_bytes = add(self.usage.extra_bytes, e)?;
        Ok(())
    }
}
