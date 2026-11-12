// SPDX-License-Identifier: MIT
//! Source-derived requested heap for the SAME canonical archive owner.
//!
//! The accepted Rust 1.88 std HashSet source uses hashbrown 0.15.3; the
//! qualified stable std uses 0.17.1. This is separate from ZIP's dependency.
//! Both insertion-only tables use capacity_to_buckets and at most 16-byte
//! groups. H_s(k)=align16(s*k)+k+16. Lowercase insertions (including pending
//! collision) <=2056, old/new buckets <=2048+4096: H24 overlap=153632.
//! Validated ASCII lowercase bytes <=2056*180=370080. The exact lower hint
//! on canonical files collect allocates at most H16(4096)=69648 once; removals never
//! grow/shrink it. Vec<VerifiedEntry> starts empty and doubles; pending+
//! completed <=2048, slot old/new <=1024+2048, hence 245760 at size80.
//! Exact path/MIME/SHA strings <=(180+127+64)*2048=759808.
//!
//! Error paths precede the author path limit: raw name and its UTF8 clone
//! may each be65535, so 131070 coexist. ZIP's retained decoded CP437/lossy
//! name may be3*65535=196605. Diagnostics interpolate that name before path
//! validation. With L=196605+4096, fmt old/new<=3L and fixed internal ZIP/
//! flate2/error (including typed cancellation) allowance256, Darchive=602359.
//! Thus WV=153632+370080+69648+245760+759808+131070+602359=2332357.
//!
//! The bounded manifest loop appends <=64KiB only after a successful read.
//! It starts empty and doubles; MAX+1 actual read cap gives raw backing
//! Craw<=524288, growth old+new Graw<=262144+524288=786432. The reader is
//! gone before parsing, while raw bytes survive through entry verification.
//! EOF never reserves: full-size 64KiB reads retain262144 for MAX, while a
//! final MAX+1 byte can grow to524288. These observations validate this loop,
//! not the retired read_to_end's reserve-before-EOF behavior.
//! Let O/Z be the original effective ZIP opening/retained fees and Dreader
//! max(Stored,Deflate), obtained by actual generic size_of at the ZIP owner.
//! Four exclusive phases (compute EACH then max, never sum all phases):
//! opening=O+Darchive; read=Z+Dreader+Graw+Darchive;
//! parse=Z+Craw+Wmanifest(MAX); verify=Z+Craw+Rmanifest(MAX)+Dreader+WV.
//! Returned identity=Rmanifest+Rverified from the SAME original manifest fee.
//!
//! Caller Read/Seek/Drop allocations, preowned arbitrary caller IO errors,
//! stack, allocator overhead/RSS, and independent process catalog are excluded.
//! Cold/permanent catalog fees are exposed separately and are not job refunds.
//! Supported 64-bit layout/source/lock/features must be requalified when changed.
//! This API admits no native job, asset handle, model input or GPU runtime.

use std::{io::Read, mem::size_of};

use zip::{read::MetadataLimits, CompressionMethod};

use super::{effective_metadata_limits, VerifiedEntry};
use crate::{manifest::ManifestHeapBounds, PackageError, Result, MAX_FILES, MAX_MANIFEST_BYTES};

/// Pre-opening inline bound for canonical identity inspection of a physical
/// package byte upper bound. A valid query allocates nothing, reads no ZIP and
/// does not initialize the process catalog. Caller limits can only tighten it.
///
/// ```compile_fail
/// use hertz_wallpaper::archive::CanonicalIdentityHeapBounds;
/// let _ = CanonicalIdentityHeapBounds { workspace: 0 };
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanonicalIdentityHeapBounds {
    physical_bytes: u64,
    limits: MetadataLimits,
    phases: [u64; 4],
    workspace: u64,
    zip_retained: u64,
    reader: u64,
    raw_retained: u64,
    raw_growth: u64,
    verification: u64,
    manifest: ManifestHeapBounds,
}

impl CanonicalIdentityHeapBounds {
    /// Use trusted exact immutable package length, or an admitted physical byte
    /// upper bound <=MAX_PACKAGE_BYTES. None uses the original container caps.
    /// R identifies the original concrete bottom reader layout without opening
    /// or constructing it. Caller-created manifests/costs cannot forge a seal.
    pub fn for_package_bytes<R: Read>(
        physical_bytes: u64,
        requested: Option<MetadataLimits>,
    ) -> Result<Self> {
        let limits = effective_metadata_limits(physical_bytes, requested)?;
        if MAX_FILES != 2048
            || MAX_MANIFEST_BYTES != 262144
            || size_of::<usize>() != 8
            || size_of::<String>() != 24
            || size_of::<&str>() != 16
            || size_of::<VerifiedEntry>() != 80
        {
            return Err(heap_error(
                "canonical identity heap requires verified 64-bit layout",
            ));
        }
        let manifest = ManifestHeapBounds::for_bytes(MAX_MANIFEST_BYTES as u64)
            .map_err(|_| heap_error("canonical manifest heap source/layout is not qualified"))?;
        let zip = limits
            .checked_heap_bounds()
            .map_err(|_| heap_error("canonical ZIP metadata heap source/layout overflow"))?;
        let stored = limits
            .checked_read_heap_bounds::<R>(CompressionMethod::Stored)
            .map_err(|_| heap_error("canonical Stored reader heap is not qualified"))?;
        let deflate = limits
            .checked_read_heap_bounds::<R>(CompressionMethod::Deflated)
            .map_err(|_| heap_error("canonical Deflate reader heap is not qualified"))?;
        let reader = stored
            .additional_reader_bytes
            .max(deflate.additional_reader_bytes) as u64;
        let zip_retained = zip.retained_metadata_bytes as u64;
        let raw_retained = (MAX_MANIFEST_BYTES as u64 + 1)
            .checked_next_power_of_two()
            .ok_or_else(|| heap_error("canonical raw manifest heap overflow"))?;
        let raw_growth = add(raw_retained / 2, raw_retained)?;
        let diagnostic = add(mul(3, add(mul(3, u16::MAX as u64)?, 4096)?)?, 256)?;
        let verification = sum(&[
            add(
                table(size_of::<String>() as u64, 2048)?,
                table(size_of::<String>() as u64, 4096)?,
            )?,
            mul(180, (MAX_FILES + 8) as u64)?,
            table(size_of::<&str>() as u64, 4096)?,
            mul(
                size_of::<VerifiedEntry>() as u64,
                (MAX_FILES + MAX_FILES / 2) as u64,
            )?,
            mul(180 + 64 + 127, MAX_FILES as u64)?,
            mul(2, u16::MAX as u64)?,
            diagnostic,
        ])?;
        let phases = [
            add(zip.opening_peak_bytes as u64, diagnostic)?,
            sum(&[zip_retained, reader, raw_growth, diagnostic])?,
            sum(&[
                zip_retained,
                raw_retained,
                manifest.workspace_requested_bytes(),
            ])?,
            sum(&[
                zip_retained,
                raw_retained,
                manifest.retained_manifest_requested_bytes(),
                reader,
                verification,
            ])?,
        ];
        Ok(Self {
            physical_bytes,
            limits,
            phases,
            workspace: phases.into_iter().max().unwrap_or(0),
            zip_retained,
            reader,
            raw_retained,
            raw_growth,
            verification,
            manifest,
        })
    }

    pub fn physical_package_bytes(self) -> u64 {
        self.physical_bytes
    }
    pub fn effective_metadata_limits(self) -> MetadataLimits {
        self.limits
    }
    /// Opening, manifest read, manifest parse, entry verification, in that order.
    pub fn phase_requested_bytes(self) -> [u64; 4] {
        self.phases
    }
    pub fn workspace_requested_bytes(self) -> u64 {
        self.workspace
    }
    pub fn retained_metadata_requested_bytes(self) -> u64 {
        self.zip_retained
    }
    pub fn active_reader_requested_bytes(self) -> u64 {
        self.reader
    }
    pub fn raw_manifest_retained_requested_bytes(self) -> u64 {
        self.raw_retained
    }
    pub fn raw_manifest_growth_requested_bytes(self) -> u64 {
        self.raw_growth
    }
    pub fn entry_verification_workspace_requested_bytes(self) -> u64 {
        self.verification
    }
    /// Maximum successful returned identity. The actual seal exposes the smaller
    /// bound from its own recorded actual original manifest length.
    pub fn retained_identity_requested_bytes(self) -> u64 {
        self.manifest.retained_identity_requested_bytes()
    }
    pub fn catalog_cold_requested_bytes(self) -> u64 {
        self.manifest.catalog_cold_requested_bytes()
    }
    pub fn catalog_retained_requested_bytes(self) -> u64 {
        self.manifest.catalog_retained_requested_bytes()
    }
    pub fn workspace_with_live_base(self, live_base: u64) -> Result<u64> {
        add(self.workspace, live_base)
    }
}

fn heap_error(message: &'static str) -> PackageError {
    PackageError::new("canonical_identity_heap_limit", message)
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| heap_error("canonical identity heap addition overflow"))
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| heap_error("canonical identity heap multiplication overflow"))
}
fn sum(terms: &[u64]) -> Result<u64> {
    terms.iter().try_fold(0, |total, &term| add(total, term))
}
fn table(item: u64, buckets: u64) -> Result<u64> {
    if buckets == 0 {
        return Ok(0);
    }
    let aligned = add(mul(item, buckets)?, 15)? & !15;
    sum(&[aligned, buckets, 16])
}
