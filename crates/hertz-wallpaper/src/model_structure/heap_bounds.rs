// SPDX-License-Identifier: MIT
//! Requested heap of the original full model inspector, including failures.
//!
//! This is a syntax envelope, not an author-count estimate. The caller supplies
//! the *actual bounded JSON chunk length* (or MAX_TEXT_BYTES before opening),
//! and the immutable manifest used by the original image inspector. No parse,
//! allocation ledger, reachability filter or static-loader profile is used.
//! Package/ZIP/manifest storage and caller buffers are outside this result.
//!
//! Derivation for the supported Rust 1.88/stable alloc sources (B=6):
//! * A nonempty String->usize tree has H(m)<=368+96(m-1). Non-root
//!   nodes have >=5 keys, internal nodes have >=2 children, so N<=1+(m-1)/5,
//!   I<=(N-1)/2 and H<=368N+96I. For m>=12 this implies the inequality;
//!   m<=11 is one leaf. Insertion may have one unfinished split allocation;
//!   its allowance is fixed below. Clone creates only nodes in the source
//!   shape, including partially initialized nodes, and exact cloned strings.
//! * Assign a target map its preceding '['/',' plus braces, key quotes,
//!   colon, minimum index digit, and member commas: 5m+2 bytes, excluding
//!   key contents. Limited's capacity <=2n assigns <=48 bytes per map.
//!   H(m)+48 <=60(5m+2). Empty maps use <=48/3=16 bytes per syntax byte.
//! * After original author totals and view-role checks, inspect_primitive
//!   moves its checked attribute/target trees and keys into the facts. Custom
//!   semantics such as '_' remain legal. ONE tree remains live, while target
//!   Vec conversion has <=48+24 bytes per map of old+new slots. Hence
//!   H(m)+72 <=64(5m+2), including the m=1 empty-key error case (440<=448).
//!   Owned keys and <=3e decoder scratch use their disjoint encoded key
//!   contents; unescaped keys borrow SliceRead without growing scratch.
//! * Other owned strings (including discarded names, metadata identifiers,
//!   partial invalid keys and a cloned animation name) cost <=2e, with at
//!   most 3e decoder scratch assigned to ONE disjoint token that caused its
//!   current high-water allocation, plus its byte-Vec minimum of eight.
//!   Oversize attribute keys fail before tree insertion. Serde's initial
//!   diagnostic may coexist with partial Schema: its formatted token (even
//!   Rust Debug's <=6-fold escaping) uses that current token's 64-byte rate.
//!   Outer diagnostics are made after serde drops partial Schema. Scanner
//!   errors use the current uninserted key token, inside the 56J phase.
//! * Primitive slots use <=2*112+96 bytes per record, assigned to its own
//!   braces, preceding delimiter and required '"attributes":' (>=16 bytes),
//!   excluding all nested map/string/array tokens. Sampler/channel slots use
//!   <=2*24+24 / <=2*40+32 and their own required field punctuation.
//!   Each usize/f64 array value owns a digit and preceding '['/',' (>=2
//!   bytes): Schema+exact copy <=24 bytes. Children/scene roots move their
//!   original allocation. Inline root records are the fixed size_of terms.
//!   Extras, fixed arrays and nested material/camera structs retain no heap.
//!
//! These spans are disjoint; whitespace, longer numbers and field names only
//! add slack. Therefore the joint nested+strings+decoder bound is 64J, not
//! a sum of separately maximized cJ categories. It covers unselected records
//! and the current not-yet-pushed element. Only ONE Limited backing can grow
//! at a time; its old backing is added once, using the largest local limit.
//! After Schema exits, retained map NODES have a separate checked global
//! constant: <=16384 base maps, <=32 keys each; target nonempty maps have
//! <=16384 keys total. Retained keys, other strings, target Vec slots,
//! primitive slots and numeric/index arrays jointly fit 32J. This avoids
//! assuming a minimum semantic length for the historically legal '_' key.
//!
//! Root arrays, exact derived root arrays and scratch are added as fixed
//! *capacity* terms. Original morph/skin global checks precede derived facts;
//! animation's per-clip aggregate check precedes that clip's exact copies.
//! Node finalization uses explicit exact-capacity Vecs. Numeric starts after
//! Schema drops; its original job/layout/heap/window and admitted skin arena
//! are added to 32J, never to the Schema phase. Global allocation failure
//! does not keep a failed allocation; partial trees/Vecs drop by their normal
//! initialized lengths before returning. Allocator overhead and stack/RSS
//! are not requested heap and are not claimed here.

use std::{
    mem::{size_of, MaybeUninit},
    ptr::NonNull,
    sync::Arc,
};

use super::*;

/// Conservative admission bounds for one original full model inspection.
/// Private construction prevents substituting unchecked author statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelHeapBounds {
    json_bytes: u64,
    opening: u64,
    schema_and_structure: u64,
    numeric: u64,
    retained: u64,
}

impl ModelHeapBounds {
    /// MAX_TEXT_BYTES may be supplied before reading a GLB chunk header. The
    /// manifest must stay immutable through inspection. Its owned storage is
    /// excluded; all image aliases cloned FROM it are included, even if the
    /// model eventually fails. This method neither validates the manifest nor
    /// grants native/GPU preparation or the caller's 320 MiB reservation.
    pub fn for_json_bytes(json_bytes: u64, manifest: &Manifest) -> Result<Self> {
        if json_bytes == 0 || json_bytes > crate::MAX_TEXT_BYTES {
            return Err(heap_error(
                "JSON length exceeds the original model text limit",
            ));
        }
        if size_of::<usize>() != 8
            || size_of::<AttributeLeaf>() != 368
            || size_of::<AttributeInternal>() != 464
            || size_of::<KeySetLeaf>() != 280
            || size_of::<KeySetInternal>() != 376
            || size_of::<Primitive>() != 112
            || size_of::<ModelPrimitive>() != 96
            || animation::SCHEMA_SLOT_BYTES != (24, 40)
            || size_of::<ModelAnimationSampler>() != 24
            || size_of::<ModelAnimationChannel>() != 32
            || size_of::<Leaf<String, Arc<[PackageImageRef]>>>() != 456
        {
            return Err(heap_error(
                "model heap layout requires the verified 64-bit alloc layout",
            ));
        }
        let aliases = manifest_alias_bytes(manifest)?;
        let schema = schema_roots()?;
        let facts = fact_roots()?;
        let scratch = structure_scratch()?;
        let grow = largest_old_backing()?;
        let retained_maps = retained_map_nodes()?;
        // 64 KiB absorbs fixed error prefixes, serde error boxes, byte scratch
        // minimum, a current BTree split, and Arc headers. Lexical has its own
        // source-derived fixed bigint bound, not an input-sized second tree.
        // Outer input-dependent formatted errors have no live Schema and fit
        // 56J, including Debug escaping and old/new formatting buffers.
        let fixed = add(64 * 1024, lexical_heap_bound()?)?;
        let opening = sum(&[json_bytes, mul(56, json_bytes)?, fixed])?;
        let schema_and_structure = sum(&[
            json_bytes,
            mul(64, json_bytes)?,
            schema,
            facts,
            scratch,
            grow,
            aliases,
            fixed,
        ])?;
        let numeric = sum(&[
            json_bytes,
            mul(32, json_bytes)?,
            facts,
            retained_maps,
            aliases,
            crate::model_binary::requested_numeric_heap_bound()?,
            fixed,
        ])?;
        let retained = sum(&[
            json_bytes,
            mul(32, json_bytes)?,
            facts,
            retained_maps,
            aliases,
            crate::MAX_PATH_BYTES as u64,
        ])?;
        Ok(Self {
            json_bytes,
            opening,
            schema_and_structure,
            numeric,
            retained,
        })
    }

    pub fn json_bytes(self) -> u64 {
        self.json_bytes
    }
    /// JSON read, duplicate scanner, finite traversal and header parsing.
    pub fn opening_requested_bytes(self) -> u64 {
        self.opening
    }
    /// Maximum requested model heap through full structure and numeric checks.
    /// Add the caller's live package/manifest/base with checked arithmetic.
    pub fn workspace_requested_bytes(self) -> u64 {
        self.opening
            .max(self.schema_and_structure)
            .max(self.numeric)
    }
    /// Full CheckedGlbResource including original JSON; not compact ModelInput.
    /// Deep Clone needs another bound while the source remains live.
    pub fn retained_requested_bytes(self) -> u64 {
        self.retained
    }
    pub fn schema_structure_requested_bytes(self) -> u64 {
        self.schema_and_structure
    }
    pub fn numeric_requested_bytes(self) -> u64 {
        self.numeric
    }

    pub fn workspace_with_live_base(self, live_base: u64) -> Result<u64> {
        add(self.workspace_requested_bytes(), live_base)
    }
}

// Exact field types/order of alloc::collections::btree::node. LeafNode has
// Rust layout, InternalNode has repr(C); layout witnesses use ORIGINAL trees.
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
type AttributeLeaf = Leaf<String, usize>;
type AttributeInternal = Internal<String, usize>;
type KeySetLeaf = Leaf<String, ()>;
type KeySetInternal = Internal<String, ()>;

fn heap_error(message: &'static str) -> PackageError {
    PackageError::new("model_heap_limit", message)
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| heap_error("model heap addition overflow"))
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| heap_error("model heap multiplication overflow"))
}
fn sum(terms: &[u64]) -> Result<u64> {
    terms.iter().try_fold(0, |total, &term| add(total, term))
}
fn array<T>(capacity: usize) -> Result<u64> {
    mul(capacity as u64, size_of::<T>() as u64)
}

// Limited explicitly caps its last doubling at N; every root capacity <=N.
fn schema_roots() -> Result<u64> {
    sum(&[
        array::<Buffer>(MAX_MODEL_RECORDS)?,
        array::<BufferView>(MAX_MODEL_RECORDS)?,
        array::<Accessor>(MAX_MODEL_RECORDS)?,
        array::<Skin>(MAX_MODEL_RECORDS)?,
        array::<Mesh>(MAX_MODEL_NODES)?,
        array::<Node>(MAX_MODEL_NODES)?,
        array::<Scene>(MAX_MODEL_NODES)?,
        array::<Camera>(MAX_MODEL_NODES)?,
        array::<Image>(MAX_MODEL_IMAGE_RECORDS)?,
        array::<Texture>(MAX_MODEL_IMAGE_RECORDS)?,
        array::<Sampler>(MAX_MODEL_IMAGE_RECORDS)?,
        array::<Material>(MAX_MODEL_IMAGE_RECORDS)?,
        array::<String>(2 * MAX_MODEL_IMAGE_RECORDS)?,
        array::<animation::Animation>(MAX_MODEL_ANIMATIONS)?,
    ])
}
fn fact_roots() -> Result<u64> {
    sum(&[
        array::<ModelBufferView>(MAX_MODEL_RECORDS)?,
        array::<ModelAccessor>(MAX_MODEL_RECORDS)?,
        array::<ModelMesh>(MAX_MODEL_NODES)?,
        array::<ModelNode>(MAX_MODEL_NODES)?,
        array::<ModelScene>(MAX_MODEL_NODES)?,
        array::<ModelSkin>(MAX_MODEL_RECORDS)?,
        array::<ModelSkinBinding>(MAX_MODEL_RECORDS)?,
        array::<ModelImage>(MAX_MODEL_IMAGE_RECORDS)?,
        array::<ModelAnimation>(MAX_MODEL_ANIMATIONS)?,
        array::<Option<Vec<f64>>>(MAX_MODEL_NODES)?,
    ])
}
fn structure_scratch() -> Result<u64> {
    // Node parents/pending; skin graph's four usize arrays and ancestor rows,
    // DFS pending (<=2N), generations, relation/seen arrays, author summary.
    // View roles, vertex flags/first vertex and material coordinate scratch.
    sum(&[
        array::<Option<usize>>(MAX_MODEL_NODES)?,
        array::<usize>(MAX_MODEL_NODES)?,
        array::<usize>(4 * MAX_MODEL_NODES)?,
        array::<[usize; 13]>(MAX_MODEL_NODES)?,
        array::<(usize, bool)>(2 * MAX_MODEL_NODES)?,
        array::<u32>(MAX_MODEL_NODES)?,
        array::<(usize, usize)>(MAX_MODEL_NODES)?,
        array::<bool>(MAX_MODEL_NODES)?,
        array::<MeshSkinRange>(MAX_MODEL_NODES)?,
        array::<u32>(MAX_MODEL_RECORDS)?,
        array::<u8>(MAX_MODEL_RECORDS)?,
        array::<bool>(MAX_MODEL_RECORDS)?,
        array::<Option<usize>>(MAX_MODEL_RECORDS)?,
        array::<u32>(5)?,
        // Per-clip target set: 16-byte key, zero-sized value. At most 16384
        // channels have passed the aggregate check before any target insert.
        add(
            size_of::<Leaf<(usize, AnimationPath), ()>>() as u64,
            mul(64, MAX_MODEL_RECORDS as u64)?,
        )?,
    ])
}
fn largest_old_backing() -> Result<u64> {
    // All nested slots <=Primitive(112); Node(416) is largest root record.
    // Last old capacity for limit 5000 is 4096; for 16384 it is 8192.
    Ok(array::<Node>(4096)?.max(array::<Primitive>(8192)?))
}

fn retained_map_nodes() -> Result<u64> {
    // inspect_skin_author checks aggregate primitives before copying any
    // facts; inspect_morph_totals checks aggregate target references first.
    // Nonempty target maps <=references, so H(m)<=368m suffices for their
    // total. Base attributes retain the original local 32-key limit.
    let leaf = size_of::<AttributeLeaf>() as u64;
    let base_map = add(leaf, mul(96, MAX_MODEL_ATTRIBUTES as u64 - 1)?)?;
    sum(&[
        mul(MAX_MODEL_RECORDS as u64, base_map)?,
        mul(MAX_MODEL_RECORDS as u64, leaf)?,
    ])
}

fn lexical_heap_bound() -> Result<u64> {
    // Locked serde_json lexical: bhcomp consumes <=769 digits; moderate_path
    // returns before bhcomp outside cached exponent [-350,309]. Adjusting the
    // <=20 significant u64 digits gives sci_exp within [-350,328], hence its
    // scaled exponent lies within [-1118,329]. Widen to [-1280,512]. A 769
    // digit mantissa needs <4*769 bits; theor needs <64+3*1280 bits. Widen the
    // binary exponent to [-2048,2048]; either alignment shift leaves <8192
    // bits. Arithmetic products/sums therefore need <=256 u64 limbs including
    // carry, with requested capacities <=512. Karatsuba cutoff32 halves to
    // <=129,65,33,17: four nonterminal levels, <=6 live owned Vecs at each;
    // <=3 bottom temporaries +2 real/theor owners +one moving-growth old
    // allocation <32 Vecs. Uneven multiplication uses fewer temporaries.
    // Bigint's initial capacity20 and all clones are inside this ceiling.
    mul(32, mul(512, size_of::<u64>() as u64)?)
}

fn manifest_alias_bytes(manifest: &Manifest) -> Result<u64> {
    let mut references = 0_u64;
    let mut strings = 0_u64;
    for asset in &manifest.assets {
        if !matches!(asset.kind, AssetKind::Image | AssetKind::Texture) {
            continue;
        }
        references = add(references, 1)?;
        strings = add(strings, asset.id.len() as u64)?;
        for variant in &asset.variants {
            references = add(references, 1)?;
            strings = sum(&[strings, asset.id.len() as u64, variant.id.len() as u64])?;
        }
    }
    // A source/variant belongs to one path. Cached same-path Arc aliases never
    // multiply the cloned id storage. Vec+Arc overlap is <=2R*size_of, since
    // the exact-count Vec has no shrink. Each distinct path has one Arc header.
    // ModelImage path/mime/SHA and alias-map path are separate bounded clones.
    let images = MAX_MODEL_IMAGE_RECORDS as u64;
    // Original public inspection also accepts hand-built Manifests. Charge
    // their actual SHA clone length; canonical validation is a caller concern.
    let sha_bytes = manifest
        .files
        .iter()
        .map(|file| file.sha256.len())
        .max()
        .unwrap_or(0) as u64;
    sum(&[
        mul(2 * size_of::<PackageImageRef>() as u64, references)?,
        strings,
        mul(2 * size_of::<usize>() as u64, images.min(references))?,
        mul(
            add(2 * crate::MAX_PATH_BYTES as u64 + 15, sha_bytes)?,
            images,
        )?,
        // String->Arc<[PackageImageRef]>: leaf456/internal552, slope112.
        size_of::<Leaf<String, Arc<[PackageImageRef]>>>() as u64,
        mul(112, images)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_layout_and_checked_equations() {
        assert_eq!(
            (size_of::<AttributeLeaf>(), size_of::<AttributeInternal>()),
            (368, 464)
        );
        assert_eq!(
            (size_of::<KeySetLeaf>(), size_of::<KeySetInternal>()),
            (280, 376)
        );
        assert_eq!(size_of::<Node>(), 416);
        assert_eq!(size_of::<Primitive>(), 112);
        assert_eq!(animation::SCHEMA_SLOT_BYTES, (24, 40));
        assert!(add(u64::MAX, 1).is_err());
        assert!(mul(u64::MAX, 2).is_err());
        assert!(array::<Node>(usize::MAX).is_err());
        for m in 1_u64..=MAX_MODEL_ATTRIBUTES as u64 {
            let h = 368 + 96 * (m - 1);
            assert!(h + 48 * m <= 60 * (5 * m + 2));
            assert!(h + 72 <= 64 * (5 * m + 2));
        }
    }
}
