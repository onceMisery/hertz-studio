// SPDX-License-Identifier: MIT
//! Requested heap of the ORIGINAL bounded manifest byte parser, including
//! errors and partial typed construction. These are source equations, not
//! allocator-sample slopes or successful author-count estimates.
//!
//! Source contract: locked serde 1.0.229 / serde_json 1.0.151 / zmij, the
//! literal seeds in crate::json, Rust 1.88/stable 64-bit alloc (BTree B=6),
//! float_roundtrip with or without raw_value. Number must remain inline and
//! Map must remain BTree-backed; arbitrary_precision/preserve_order layouts
//! are rejected. Layout/source/feature changes require a reviewed new proof.
//!
//! Assign each scanner-passed object edge five structural bytes, array edge
//! two, plus disjoint string spelling Sraw and excess numeric spelling Nextra:
//! 5Eo+2Ea+Sraw+Nextra<=M. Nonempty object/array counts O<=Eo, A<=Ea; owned
//! decoded strings S<=Sraw. No successful length/count checks are used here.
//! Insertion-only BTree nodes have N<=1+(e-1)/5, I<=(N-1)/2, including pending
//! splits. Value leaf/internal requests are 632/728, String-set 280/376.
//! Hence Value forest<=136Eo+496O; empty-start Value Vec old+new backing
//! <=96(Ea+A). Owned Value iterators retain their original Vec/tree backing
//! through traversal, including the embedded pending value. Literal seeds
//! reconstruct the same ordinary scalar/array/map trees, never raw carriers.
//!
//! Byte decoding shares one scratch Vec, high-water q<=Sraw+Nextra+1, whose
//! old+new requests<=3q+20. Locked float_roundtrip's separate lexical owner:
//! MAX_DIGITS=769; moderate_path bounds bhcomp scientific exponent [-350,328],
//! conservatively scaled [-1280,512]. Aligned integers stay below8192 bits;
//! products/carry <=256 u64 limbs, capacities<=512. Karatsuba cutoff32 has
//! four nonterminal levels (129/65/33/17), <=6 Vecs each, plus bottom/real/
//! theor/growth extras, <32 live Vecs: 32*512*8=131072. Reserved splice moves
//! the tail and has an empty residual. Lexical exits before content policy.
//! Initial Value<=ceil(632M/5)+23+131072; later V(x)=ceil(632x/5)+20.
//!
//! Serde Content pair/value slots64/32 plus cautious min(hint,1MiB/slot)
//! preallocation and push have old+new<=3n even before the first invalid
//! child (k=0). Content<=192Eo+96Ea<=48M; Some/Newtype boxes are unreachable
//! from original Value. Asset/File/Variant/property slots80/80/152/24 have
//! partial hinted backing<=456Ea. Two old/new Values plus Content/typed
//! slots <=1456Eo+936Ea+8Sraw+40<=468M+40, including failure/cleanup.
//! Full contextual typed storage T=248M+20. Original file/asset/variant
//! checks bound their coexisting clone sets by
//! 2048*(376+180)+(376+64)*ceil(M/15), only AFTER typed construction.
//!
//! First check_encoded_size serializes the entire arbitrary property before
//! the 2KiB decision: zmij float output<=24, integer<=20 and encoded String
//! spelling<=original. Output<=24M; old+new S(M)=max(128,72M). Previous
//! accepted descriptors/ids/targets/option slots/exact Vec/clones contribute
//! P=184*64+64*(56*64+2048+376+64+728+128). After that first size success,
//! B=2048: original property, cloning/dying traversal/reconstructed Values
//! coexist. Partial extra=3V(B)+48B+84B+temporary+S(B+512), including hinted
//! options before missing fields or >64 rejection. Constraint json! temporary
//! <=632*65+32*64+B. Normalized target sequences add <512 spelling bytes;
//! second serialization and contextual checks preserve original ordering.
//! builtin_schema only borrows catalog/defaults; property temporaries drop.
//!
//! Diagnostics use original Unexpected::Str Debug<=6M plus static prefixes
//! <=4096 over four original error generations. Wrappers print prior text
//! directly. fmt growth/shrink old+new<=3L, L=6M+4096; four error boxes add256:
//! D(M)=12L+256=72M+49408. Included at EACH owning stage before old trees drop.
//! Eight exclusive phases (all checked, then max):
//! 1 ceil(376M/3)+4M+20+D; 2 ceil(632M/5)+23+131072+D;
//! 3 468M+40+D; 4 T+sets+D; 5 T+sets+P+S(M)+D;
//! 6 T+sets+P+partial+D; 7 T+sets+P+D; 8 D.
//!
//! SUCCESS retention is canonical byte-path capacity, never arbitrary caller
//! Manifest/Map capacity. Metadata Vec C<=2n; Variant sequence costs>=15
//! disjoint bytes, Asset>=16, File>=80; strings charged once:
//! metadata<=ceil(304M/15)+M. Up to64 accepted properties each retain root,
//! constraints, target, 64 option maps AND PropertyType {"select":null}:
//! 68 leaves, not67. Rproperties=64*(68*632+64*32+B+24)=3014144.
//! Frozen builtin scalar params max tree/key/largest selected String=5001.
//! VerifiedEntry Vec is empty-start push C<=2048; exact decoded path<=180,
//! stack SHA formatting String capacity64, MIME clone<=127:
//! Rverified=80*2048+(180+64+127)*2048=923648.
//!
//! The SAME embedded catalog owner is separate: 77859 bytes with SHA below;
//! 29 scenes, 1029 Value objects/5383 entries, 100 arrays/333 elements,
//! 45132 String bytes. Source tree sum1076824 + arrays14080 + Strings45132
//! gives permanent1136036. Array overlap15488, q<=77859 and lexical131072
//! give direct build1502113; scanner742068; raw-span hash1447556.
//! Cold opening=max=1502113, permanent=1136036. A true cold sample
//! peak756724/retained756660 witnesses cleanup, never defines these fees.
//! validate_properties resolves builtin_schema even with zero properties;
//! unknown first builtin also initializes OnceLock. Do not refund this
//! permanent process owner in a job or hide it behind warm initialization.
//!
//! Caller source bytes, original archive manifest Vec, ZIP/reader, archive
//! verification workspace, outer/pins/jobs/full-model/native/GPU owners,
//! allocator overhead and stack/RSS are excluded. No runtime grant is made.

use std::{
    mem::{size_of, MaybeUninit},
    ptr::NonNull,
};

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use super::{AssetDescriptor, FileEntry, Variant};
use crate::{PackageError, Result, MAX_MANIFEST_BYTES};

const B: u64 = 2048;
const CATALOG_COLD: u64 = 1_502_113;
const CATALOG_RETAINED: u64 = 1_136_036;
const CATALOG_SHA256: [u8; 32] = [
    0xc5, 0x62, 0x3a, 0xc8, 0x46, 0xc4, 0xfc, 0xec, 0x62, 0x9b, 0x6e, 0x12, 0x3e, 0xd0, 0xd8, 0x64,
    0x66, 0x50, 0x62, 0xaf, 0xc4, 0xd7, 0xd7, 0x94, 0x95, 0x45, 0x03, 0x98, 0x56, 0xfd, 0xfc, 0x28,
];

/// Checked conservative fees for the original manifest byte parser.
/// Construction stores only inline numbers; a valid query allocates no heap,
/// parses nothing and does not initialize the process catalog.
///
/// ```compile_fail
/// use hertz_wallpaper::manifest::ManifestHeapBounds;
/// let _ = ManifestHeapBounds { manifest_bytes: 1, workspace: 0,
///     retained_manifest: 0, retained_identity: 0 };
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManifestHeapBounds {
    manifest_bytes: u64,
    workspace: u64,
    retained_manifest: u64,
    retained_identity: u64,
}

impl ManifestHeapBounds {
    /// Actual bounded input length, or MAX_MANIFEST_BYTES before opening.
    /// Zero covers the original empty-input failure; it does not imply a
    /// successful manifest. Small inputs conservatively retain the full
    /// successful property allowance. This does not validate author input.
    pub fn for_bytes(manifest_bytes: u64) -> Result<Self> {
        if manifest_bytes > MAX_MANIFEST_BYTES as u64 {
            return Err(heap_error("manifest length exceeds its original limit"));
        }
        verify_layout()?;
        verify_catalog_source()?;
        let phases = phases(manifest_bytes)?;
        let metadata = add(ceil_div(mul(304, manifest_bytes)?, 15)?, manifest_bytes)?;
        let properties = mul(64, sum(&[mul(68, 632)?, mul(64, 32)?, B, 24])?)?;
        let retained_manifest = sum(&[metadata, properties, 5001])?;
        let verified = add(mul(80, B)?, mul(sum(&[180, 64, 127])?, B)?)?;
        Ok(Self {
            manifest_bytes,
            workspace: phases.into_iter().max().unwrap_or(0),
            retained_manifest,
            retained_identity: add(retained_manifest, verified)?,
        })
    }

    pub fn manifest_bytes(self) -> u64 {
        self.manifest_bytes
    }
    /// Maximum of all eight original parser stages, including errors.
    pub fn workspace_requested_bytes(self) -> u64 {
        self.workspace
    }
    /// Successful original Manifest only, excluding process catalog storage.
    /// A deep clone needs another allowance while the source remains live.
    pub fn retained_manifest_requested_bytes(self) -> u64 {
        self.retained_manifest
    }
    /// Successful canonical identity (Manifest plus original VerifiedEntry Vec).
    pub fn retained_identity_requested_bytes(self) -> u64 {
        self.retained_identity
    }
    /// Opening the original catalog OnceLock in a cold process. The caller
    /// must admit this process owner separately from manifest job workspace.
    pub fn catalog_cold_requested_bytes(self) -> u64 {
        CATALOG_COLD
    }
    /// Permanent process catalog owner; never a refundable job reservation.
    pub fn catalog_retained_requested_bytes(self) -> u64 {
        CATALOG_RETAINED
    }
    /// Compose caller-owned live bytes with checked arithmetic. The caller
    /// remains responsible for admitting the separate process catalog owner.
    pub fn workspace_with_live_base(self, live_base: u64) -> Result<u64> {
        add(self.workspace, live_base)
    }
}

// Same exact field types/order witness as ModelHeapBounds and verified alloc
// sources. Original BTree allocations are observed independently in tests.
#[allow(dead_code)]
struct Leaf<K, V> {
    parent: Option<NonNull<()>>,
    parent_idx: MaybeUninit<u16>,
    len: u16,
    keys: [MaybeUninit<K>; 11],
    vals: [MaybeUninit<V>; 11],
}
#[repr(C)]
#[allow(dead_code)]
struct Internal<K, V> {
    data: Leaf<K, V>,
    edges: [MaybeUninit<NonNull<()>>; 12],
}

fn verify_layout() -> Result<()> {
    if size_of::<usize>() != 8
        || size_of::<Value>() != 32
        || size_of::<Number>() != 16
        || size_of::<String>() != 24
        || size_of::<Map<String, Value>>() != 24
        || size_of::<Vec<Value>>() != 24
        || size_of::<AssetDescriptor>() != 80
        || size_of::<FileEntry>() != 80
        || size_of::<Variant>() != 152
        || size_of::<crate::VerifiedEntry>() != 80
        || size_of::<Leaf<String, Value>>() != 632
        || size_of::<Internal<String, Value>>() != 728
        || size_of::<Leaf<String, ()>>() != 280
        || size_of::<Internal<String, ()>>() != 376
    {
        return Err(heap_error(
            "manifest heap requires the verified 64-bit alloc/serde layout",
        ));
    }
    Ok(())
}

fn verify_catalog_source() -> Result<()> {
    // Hash the original bytes on the stack; do not parse, initialize, format
    // the digest, copy the directory or introduce another cache/ledger.
    if crate::catalog::CATALOG_BYTES.len() != 77_859
        || Sha256::digest(crate::catalog::CATALOG_BYTES).as_slice() != CATALOG_SHA256
    {
        return Err(heap_error(
            "catalog source changed; manifest fees need a new proof",
        ));
    }
    Ok(())
}

fn heap_error(message: &'static str) -> PackageError {
    PackageError::new("manifest_heap_limit", message)
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| heap_error("manifest heap addition overflow"))
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| heap_error("manifest heap multiplication overflow"))
}
fn sum(terms: &[u64]) -> Result<u64> {
    terms.iter().try_fold(0, |total, &term| add(total, term))
}
fn ceil_div(n: u64, d: u64) -> Result<u64> {
    if d == 0 {
        return Err(heap_error("manifest heap division by zero"));
    }
    add(n / d, u64::from(!n.is_multiple_of(d)))
}
fn value_storage(x: u64) -> Result<u64> {
    add(ceil_div(mul(632, x)?, 5)?, 20)
}
fn serialization(x: u64) -> Result<u64> {
    Ok(128.max(mul(72, x)?))
}
fn phases(m: u64) -> Result<[u64; 8]> {
    let d = add(mul(72, m)?, 49_408)?;
    let typed = add(mul(248, m)?, 20)?;
    let sets = add(
        mul(B, add(376, 180)?)?,
        mul(add(376, 64)?, ceil_div(m, 15)?)?,
    )?;
    let previous = add(
        mul(184, 64)?,
        mul(64, sum(&[mul(56, 64)?, B, 376, 64, 728, 128])?)?,
    )?;
    let temporary = sum(&[mul(632, 65)?, mul(32, 64)?, B])?;
    let partial = sum(&[
        mul(3, value_storage(B)?)?,
        mul(48, B)?,
        mul(84, B)?,
        temporary,
        serialization(add(B, 512)?)?,
    ])?;
    Ok([
        sum(&[ceil_div(mul(376, m)?, 3)?, mul(4, m)?, 20, d])?,
        sum(&[ceil_div(mul(632, m)?, 5)?, 23, 131_072, d])?,
        sum(&[mul(468, m)?, 40, d])?,
        sum(&[typed, sets, d])?,
        sum(&[typed, sets, previous, serialization(m)?, d])?,
        sum(&[typed, sets, previous, partial, d])?,
        sum(&[typed, sets, previous, d])?,
        d,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_eight_source_phases_and_checked_arithmetic() {
        assert_eq!(
            phases(262_144).unwrap(),
            [
                52_827_754,
                52_189_873,
                141_607_208,
                92_764_076,
                112_093_612,
                94_495_740,
                93_219_244,
                18_923_776,
            ]
        );
        assert!(add(u64::MAX, 1).is_err());
        assert!(mul(u64::MAX, 2).is_err());
        assert!(phases(u64::MAX).is_err());
        assert!(ceil_div(1, 0).is_err());
        assert_eq!(ceil_div(u64::MAX, 2).unwrap(), 1_u64 << 63);
        assert_eq!(ceil_div(u64::MAX, u64::MAX).unwrap(), 1);
        for m in 0..=2048 {
            let fee = ManifestHeapBounds::for_bytes(m).unwrap();
            assert_eq!(
                fee.workspace_requested_bytes(),
                *phases(m).unwrap().iter().max().unwrap()
            );
        }
    }
}
