// SPDX-License-Identifier: MIT
//! Requested heap of the original successful embedded composition catalog.
//!
//! This is a fixed-source proof, NOT a bound on arbitrary public parse_catalog
//! input. The verified build uses Rust 1.88/stable 64-bit alloc BTree B=6,
//! serde 1.0.229 and serde_json 1.0.151 float_roundtrip (+ optional raw_value).
//! Dependency/std source hashes and the entire resolved feature graph are
//! audited build evidence. Equal sizes do not detect arbitrary source changes;
//! changing those sources requires another review of these equations.
//!
//! Fixed JSON has 14686 bytes, no escapes. ContractFile -> Contract only moves.
//! Seven timeModel fields decode borrowed strings to a 1-byte enum occupying
//! NodeSchema's existing padding (104 bytes). Typed retention is unchanged.
//! Owned Strings request 3451 bytes; 210 String Vecs retain 524 slots.
//! nodes/effects each reserve 8; six Value arrays reserve 4; seven AssetKind
//! Vecs reserve 8 byte slots each. Thirteen nonempty Field maps have eighteen
//! leaves/five internals (five first splits only); assets/quality/cost have
//! six/five/five leaves. Empty Value objects allocate nothing. Thus
//! R=8*Node+8*Effect+524*String+24*Value+56+18*LField+5*IField
//!   +6*LAsset+5*LQuality+5*LCost+3451=92067.
//! The duplicate scanner's actual recursive live frontier has
//! S=max(6*LSet+ISet+216,7*LSet+219)=2272, and exits before typed parsing.
//! Each active node scanner adds the 9-byte timeModel key; six keys still fit
//! its original leaf. Enum values request no owned String or container.
//! All empty-start Vec growth uses doubling/min capacity 8/4/1; the largest
//! single old backing G=max(4*Node,4*Effect,64*String)=1536. Every other live
//! request is bounded by R; old+new realloc therefore fits R+G. Raw top key
//! schemaVersion uses 13 bytes. SHA is stack GenericArray32; LowerHex writes
//! its stack64 once to an initially empty String, requesting64. Fixed float
//! mantissas <=4294967295 and decimal exponents [-4,0] use lexical fast path;
//! no scratch or Bigint. Borrowing validation neither clones nor shrinks.
//! W=max(S,R+G,R+13,R+64)=93603 is the COMPLETE cold bound, not W-R.
//! Prepare W and permanent asset R are independent conservative reservations;
//! their sum is not a physical peak.

use std::{
    mem::{align_of, size_of, MaybeUninit},
    ptr::NonNull,
};

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use super::{AssetField, Definitions, EffectCost, EffectSchema, Field, NodeSchema, QualityVariant};
use crate::AssetKind;

const CATALOG_SHA: [u8; 32] = [
    0x94, 0xe9, 0x26, 0x9f, 0xa0, 0x71, 0xe7, 0xe9, 0x11, 0x03, 0x13, 0x56, 0x20, 0x32, 0xcb, 0xc1,
    0x48, 0x53, 0x31, 0x86, 0x81, 0xad, 0x1d, 0xc8, 0x3a, 0xc5, 0x72, 0x59, 0x3d, 0xd2, 0x09, 0x68,
];

// These compile-time identities bind the original allocation semantics and
// lockfile. They do not replace the verified dependency/std source audit.
const CATALOG_SOURCE: &[u8] = include_bytes!("catalog.rs");
const JSON_SOURCE: &[u8] = include_bytes!("../json.rs");
const LOCK_SOURCE: &[u8] = include_bytes!("../../../../Cargo.lock");
const CATALOG_SOURCE_SHA: [u8; 32] = [
    0x18, 0x54, 0x7b, 0xf4, 0x51, 0x0b, 0x52, 0x7c, 0x7e, 0xf1, 0x45, 0x67, 0x33, 0x29, 0x64, 0xae,
    0x13, 0x56, 0xf8, 0x42, 0x04, 0xc3, 0xc1, 0x43, 0x78, 0xfb, 0xfc, 0x53, 0xe7, 0x58, 0x29, 0x05,
];
const JSON_SOURCE_SHA: [u8; 32] = [
    0xe9, 0x86, 0xcb, 0xed, 0x60, 0x91, 0x9d, 0x48, 0xa7, 0x0c, 0x48, 0x5c, 0x80, 0xfb, 0x0f, 0x19,
    0xad, 0x5c, 0x04, 0x5e, 0x67, 0x18, 0xc8, 0x90, 0x25, 0x05, 0x76, 0xf3, 0xcb, 0x06, 0xeb, 0x2b,
];
// Identity refreshed for the 0.3.5 release: the workspace package versions in
// Cargo.lock moved 0.3.4 -> 0.3.5. Only internal crate version strings changed;
// no locked dependency version or feature moved. Resolved serde/serde_json
// features retain alloc/default/derive/rc/std and
// alloc/default/float_roundtrip/raw_value/std respectively, so the allocation
// equations above still hold. Allocation-meter regressions must be refreshed
// for any future graph change before claiming qualification of this build.
const LOCK_SOURCE_SHA: [u8; 32] = [
    0xea, 0xe5, 0xe4, 0x89, 0x07, 0x05, 0xb9, 0x80, 0x23, 0x69, 0x5b, 0x92, 0xf3, 0x26, 0x05, 0x6d,
    0x5b, 0x3e, 0x28, 0x70, 0x8e, 0x27, 0x21, 0x62, 0x8a, 0x6a, 0xa6, 0x78, 0x69, 0x9e, 0xd5, 0xb0,
];

/// Inline checked fees for the same embedded composition catalog owner.
/// Valid and invalid queries allocate no heap and never initialize the catalog.
///
/// ```compile_fail
/// use hertz_wallpaper::document::catalog::CompositionCatalogHeapBounds;
/// let _ = CompositionCatalogHeapBounds { cold: 0, retained: 0 };
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositionCatalogHeapBounds {
    cold: u64,
    retained: u64,
}

impl CompositionCatalogHeapBounds {
    pub fn for_embedded_catalog() -> Option<Self> {
        Self::qualified(
            super::COMPOSITION_CATALOG_BYTES,
            CATALOG_SOURCE,
            JSON_SOURCE,
            LOCK_SOURCE,
            verified_layout(),
        )
    }

    fn qualified(
        bytes: &[u8],
        catalog: &[u8],
        json: &[u8],
        lock: &[u8],
        layout: bool,
    ) -> Option<Self> {
        if !layout
            || bytes.len() != 14_686
            || !matches_sha(bytes, &CATALOG_SHA)
            || !matches_text_sha(catalog, &CATALOG_SOURCE_SHA)
            || !matches_text_sha(json, &JSON_SOURCE_SHA)
            || !matches_text_sha(lock, &LOCK_SOURCE_SHA)
        {
            return None;
        }
        let retained = sum(&[
            mul(8, size_of::<NodeSchema>() as u64)?,
            mul(8, size_of::<EffectSchema>() as u64)?,
            mul(524, size_of::<String>() as u64)?,
            mul(24, size_of::<Value>() as u64)?,
            mul(56, size_of::<AssetKind>() as u64)?,
            mul(18, size_of::<Leaf<String, Field>>() as u64)?,
            mul(5, size_of::<Internal<String, Field>>() as u64)?,
            mul(6, size_of::<Leaf<String, AssetField>>() as u64)?,
            mul(5, size_of::<Leaf<String, QualityVariant>>() as u64)?,
            mul(5, size_of::<Leaf<String, EffectCost>>() as u64)?,
            3451,
        ])?;
        let scanner = sum(&[
            mul(6, size_of::<Leaf<String, ()>>() as u64)?,
            size_of::<Internal<String, ()>>() as u64,
            216,
        ])?
        .max(sum(&[mul(7, size_of::<Leaf<String, ()>>() as u64)?, 219])?);
        let growth = mul(4, size_of::<NodeSchema>() as u64)?
            .max(mul(4, size_of::<EffectSchema>() as u64)?)
            .max(mul(64, size_of::<String>() as u64)?);
        let cold = scanner
            .max(retained.checked_add(growth)?)
            .max(retained.checked_add(13)?)
            .max(retained.checked_add(64)?);
        Some(Self { cold, retained })
    }

    pub fn cold_requested_bytes(self) -> u64 {
        self.cold
    }

    pub fn retained_requested_bytes(self) -> u64 {
        self.retained
    }
}

// Field order and repr match the reviewed std alloc BTree source. Original
// allocations, including leaves/internals, are independently metered in tests.
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

fn verified_layout() -> bool {
    macro_rules! layout {
        ($ty:ty, $size:expr, $align:expr) => {
            size_of::<$ty>() == $size && align_of::<$ty>() == $align
        };
    }
    layout!(usize, 8, 8)
        && layout!(String, 24, 8)
        && layout!(Value, 32, 8)
        && layout!(Number, 16, 8)
        && layout!(Map<String, Value>, 24, 8)
        && layout!(Field, 224, 8)
        && layout!(NodeSchema, 104, 8)
        && layout!(super::TimeModel, 1, 1)
        && layout!(EffectSchema, 192, 8)
        && layout!(Definitions, 72, 8)
        && layout!(AssetField, 56, 8)
        && layout!(QualityVariant, 8, 8)
        && layout!(EffectCost, 12, 4)
        && layout!(AssetKind, 1, 1)
        && layout!(Leaf<String, Field>, 2744, 8)
        && layout!(Internal<String, Field>, 2840, 8)
        && layout!(Leaf<String, AssetField>, 896, 8)
        && layout!(Leaf<String, QualityVariant>, 368, 8)
        && layout!(Leaf<String, EffectCost>, 408, 8)
        && layout!(Leaf<String, ()>, 280, 8)
        && layout!(Internal<String, ()>, 376, 8)
}

fn matches_sha(bytes: &[u8], expected: &[u8; 32]) -> bool {
    Sha256::digest(bytes).as_slice() == expected
}

// Git may check out the same Rust/lock text as LF or CRLF. Hash borrowed spans
// directly on the stack, omitting ONLY CR immediately followed by LF. Bare CR
// and every other byte remain identity-bearing. Fixed JSON stays raw above.
fn matches_text_sha(bytes: &[u8], expected: &[u8; 32]) -> bool {
    let mut digest = Sha256::new();
    let mut start = 0;
    let mut cursor = 0;
    while cursor + 1 < bytes.len() {
        if bytes[cursor] == b'\r' && bytes[cursor + 1] == b'\n' {
            digest.update(&bytes[start..cursor]);
            start = cursor + 1;
            cursor += 2;
        } else {
            cursor += 1;
        }
    }
    digest.update(&bytes[start..]);
    digest.finalize().as_slice() == expected
}
fn mul(a: u64, b: u64) -> Option<u64> {
    a.checked_mul(b)
}
fn sum(terms: &[u64]) -> Option<u64> {
    terms
        .iter()
        .try_fold(0u64, |total, term| total.checked_add(*term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
    };

    struct QueryMeter;
    thread_local! {
        static METER: Cell<bool> = const { Cell::new(false) };
        static REQUESTS: Cell<usize> = const { Cell::new(0) };
    }
    unsafe impl GlobalAlloc for QueryMeter {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            crate::model_binary::record_compact_test_allocation();
            if METER.with(Cell::get) {
                REQUESTS.with(|count| count.set(count.get() + 1));
            }
            unsafe { System.alloc(layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            crate::model_binary::record_compact_test_allocation();
            if METER.with(Cell::get) {
                REQUESTS.with(|count| count.set(count.get() + 1));
            }
            unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) };
        }
        unsafe fn realloc(&self, pointer: *mut u8, old: Layout, size: usize) -> *mut u8 {
            crate::model_binary::record_compact_test_allocation();
            if METER.with(Cell::get) {
                REQUESTS.with(|count| count.set(count.get() + 1));
            }
            unsafe { System.realloc(pointer, old, size) }
        }
    }
    #[global_allocator]
    static ALLOCATOR: QueryMeter = QueryMeter;

    #[test]
    fn source_lock_and_layout_mismatches_fail_closed() {
        let query = |bytes, catalog, json, lock, layout| {
            CompositionCatalogHeapBounds::qualified(bytes, catalog, json, lock, layout)
        };
        REQUESTS.with(|count| count.set(0));
        METER.with(|flag| flag.set(true));
        assert!(query(
            super::super::COMPOSITION_CATALOG_BYTES,
            CATALOG_SOURCE,
            JSON_SOURCE,
            LOCK_SOURCE,
            true
        )
        .is_some());
        let mut changed_bytes = [0u8; 14_686];
        changed_bytes.copy_from_slice(super::super::COMPOSITION_CATALOG_BYTES);
        changed_bytes[0] ^= 1;
        assert_eq!(
            query(
                &changed_bytes,
                CATALOG_SOURCE,
                JSON_SOURCE,
                LOCK_SOURCE,
                true
            ),
            None
        );
        let mut changed_source = [0u8; CATALOG_SOURCE.len()];
        changed_source.copy_from_slice(CATALOG_SOURCE);
        changed_source[0] ^= 1;
        assert_eq!(
            query(
                super::super::COMPOSITION_CATALOG_BYTES,
                &changed_source,
                JSON_SOURCE,
                LOCK_SOURCE,
                true
            ),
            None
        );
        let mut changed_json = [0u8; JSON_SOURCE.len()];
        changed_json.copy_from_slice(JSON_SOURCE);
        changed_json[0] ^= 1;
        assert_eq!(
            query(
                super::super::COMPOSITION_CATALOG_BYTES,
                CATALOG_SOURCE,
                &changed_json,
                LOCK_SOURCE,
                true
            ),
            None
        );
        let mut changed_lock = [0u8; LOCK_SOURCE.len()];
        changed_lock.copy_from_slice(LOCK_SOURCE);
        changed_lock[0] ^= 1;
        assert_eq!(
            query(
                super::super::COMPOSITION_CATALOG_BYTES,
                CATALOG_SOURCE,
                JSON_SOURCE,
                &changed_lock,
                true
            ),
            None
        );
        for inputs in [
            (&b"bad"[..], CATALOG_SOURCE, JSON_SOURCE, LOCK_SOURCE, true),
            (
                super::super::COMPOSITION_CATALOG_BYTES,
                &b"bad"[..],
                JSON_SOURCE,
                LOCK_SOURCE,
                true,
            ),
            (
                super::super::COMPOSITION_CATALOG_BYTES,
                CATALOG_SOURCE,
                &b"bad"[..],
                LOCK_SOURCE,
                true,
            ),
            (
                super::super::COMPOSITION_CATALOG_BYTES,
                CATALOG_SOURCE,
                JSON_SOURCE,
                &b"bad"[..],
                true,
            ),
            (
                super::super::COMPOSITION_CATALOG_BYTES,
                CATALOG_SOURCE,
                JSON_SOURCE,
                LOCK_SOURCE,
                false,
            ),
        ] {
            assert_eq!(
                query(inputs.0, inputs.1, inputs.2, inputs.3, inputs.4),
                None
            );
        }
        assert_eq!(mul(u64::MAX, 2), None);
        assert_eq!(sum(&[u64::MAX, 1]), None);
        let text_sha: [u8; 32] = Sha256::digest(b"one\ntwo\n").into();
        assert!(matches_text_sha(b"one\ntwo\n", &text_sha));
        assert!(matches_text_sha(b"one\r\ntwo\r\n", &text_sha));
        assert!(matches_text_sha(b"one\r\ntwo\n", &text_sha));
        assert!(!matches_text_sha(b"one\rtwo\n", &text_sha));
        let mut crlf_catalog = [0u8; CATALOG_SOURCE.len() * 2];
        let mut written = 0;
        for (index, &byte) in CATALOG_SOURCE.iter().enumerate() {
            if byte == b'\r' && CATALOG_SOURCE.get(index + 1) == Some(&b'\n') {
                continue;
            }
            if byte == b'\n' {
                crlf_catalog[written] = b'\r';
                written += 1;
            }
            crlf_catalog[written] = byte;
            written += 1;
        }
        assert!(query(
            super::super::COMPOSITION_CATALOG_BYTES,
            &crlf_catalog[..written],
            JSON_SOURCE,
            LOCK_SOURCE,
            true
        )
        .is_some());
        METER.with(|flag| flag.set(false));
        assert_eq!(
            REQUESTS.with(Cell::get),
            0,
            "valid and invalid source/lock/layout queries allocate nothing"
        );
    }
}
