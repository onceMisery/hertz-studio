// SPDX-License-Identifier: MIT
//! Consuming storage conversion of the original complete checked facts.
use super::{CheckedGlbResource, NumericFacts};
use crate::{
    model_container::{BinaryChunk, GlbContainer},
    model_structure::{GlbResource, ModelImage, ModelStructure, PackageImageRef},
};
use std::{
    alloc::Layout,
    collections::BTreeMap,
    mem::{align_of, size_of, MaybeUninit},
    ptr::NonNull,
    sync::{atomic::AtomicUsize, Arc},
};

/// Inline errors: even an unsupported layout or overflowing query allocates
/// nothing. Native callers must admit their diagnostic before converting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactModelHeapError {
    UnsupportedLayout,
    Overflow,
}
type HeapResult = Result<u64, CompactModelHeapError>;

/// Full original author-indexed facts and stream certificate, without JSON.
/// Only a consuming full inspector result can mint this value.
///
/// ```compile_fail
/// use hertz_wallpaper::model_binary::CompactCheckedGlbResource;
/// let facts = CompactCheckedGlbResource::default();
/// ```
/// ```compile_fail
/// use hertz_wallpaper::{model_binary::CompactCheckedGlbResource, model_structure::ModelStructure};
/// fn mint(structure: ModelStructure) -> CompactCheckedGlbResource {
///     CompactCheckedGlbResource { structure }
/// }
/// ```
/// ```compile_fail
/// use hertz_wallpaper::model_binary::CompactCheckedGlbResource;
/// fn change(facts: &mut CompactCheckedGlbResource) {
///     facts.structure().nodes.clear();
/// }
/// ```
#[derive(Debug)]
pub struct CompactCheckedGlbResource {
    structure: ModelStructure,
    binary: Option<BinaryChunk>,
    json_bytes: u64,
    sha256: [u8; 32],
    bytes: u64,
    source_path: String,
    facts: NumericFacts,
}

impl CheckedGlbResource {
    /// Moves every original owner and releases only the original JSON backing.
    /// No parser, cloning, allocation or capacity shrinking occurs here.
    pub fn into_compact(self) -> CompactCheckedGlbResource {
        let Self {
            resource,
            sha256,
            bytes,
            source_path,
            facts,
        } = self;
        let GlbResource {
            container,
            structure,
        } = resource;
        let GlbContainer { json, binary } = container;
        let json_bytes = json.len() as u64;
        drop(json);
        CompactCheckedGlbResource {
            structure,
            binary,
            json_bytes,
            sha256,
            bytes,
            source_path,
            facts,
        }
    }
}

impl CompactCheckedGlbResource {
    pub fn structure(&self) -> &ModelStructure {
        &self.structure
    }
    pub fn binary(&self) -> Option<&BinaryChunk> {
        self.binary.as_ref()
    }
    pub fn json_bytes(&self) -> u64 {
        self.json_bytes
    }
    pub fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn source_path(&self) -> &str {
        &self.source_path
    }
    pub fn checked_accessors(&self) -> usize {
        self.structure.accessors.len()
    }
    pub fn unique_layouts(&self) -> usize {
        self.facts.unique_layouts
    }
    pub fn checked_elements(&self) -> u64 {
        self.facts.elements
    }
    pub fn checked_components(&self) -> u64 {
        self.facts.components
    }

    /// Heap backing requests, excluding this inline body. Vec/String actual
    /// capacities are charged. BTree nodes use the original alloc B=6 bound,
    /// including a conservative 368-byte root allowance for empty maps.
    /// Image reference Arcs are counted once by backing identity, without a
    /// scratch allocation or strong_count. At 4096 images the preceding scan
    /// makes at most 8386560 comparisons. Arbitrary caller Manifests have no
    /// canonical global bound on reference strings or unique slice lengths.
    pub fn retained_requested_bytes(&self) -> HeapResult {
        verify_layout()?;
        let s = &self.structure;
        let mut total = string(&self.source_path)?;
        macro_rules! count {
            ($term:expr) => {
                total = add(total, $term?)?;
            };
        }
        count!(vector(&s.buffer_views));
        count!(vector(&s.accessors));
        count!(vector(&s.meshes));
        count!(vector(&s.images));
        count!(vector(&s.animations));
        count!(vector(&s.skins));
        count!(vector(&s.skin_bindings));
        count!(vector(&s.nodes));
        count!(vector(&s.scenes));
        count!(vector(&s.node_morph_weights));
        for accessor in &s.accessors {
            if let Some(v) = &accessor.min {
                count!(vector(v));
            }
            if let Some(v) = &accessor.max {
                count!(vector(v));
            }
        }
        for mesh in &s.meshes {
            count!(vector(&mesh.primitives));
            if let Some(v) = &mesh.default_weights {
                count!(vector(v));
            }
            for primitive in &mesh.primitives {
                count!(tree(&primitive.attributes));
                count!(vector(&primitive.targets));
                for target in &primitive.targets {
                    count!(tree(target));
                }
            }
        }
        for animation in &s.animations {
            if let Some(v) = &animation.name {
                count!(string(v));
            }
            count!(vector(&animation.samplers));
            count!(vector(&animation.channels));
        }
        for skin in &s.skins {
            count!(vector(&skin.joints));
        }
        for node in &s.nodes {
            count!(vector(&node.children));
        }
        for scene in &s.scenes {
            count!(vector(&scene.nodes));
        }
        for v in s.node_morph_weights.iter().flatten() {
            count!(vector(v));
        }
        for (index, image) in s.images.iter().enumerate() {
            match image {
                ModelImage::Embedded { mime, .. } => {
                    count!(string(mime));
                }
                ModelImage::Package {
                    path,
                    mime,
                    sha256,
                    references,
                    ..
                } => {
                    count!(string(path));
                    count!(string(mime));
                    count!(string(sha256));
                    let already_counted = s.images[..index].iter().any(|previous| {
                        matches!(previous, ModelImage::Package { references: old, .. }
                            if Arc::ptr_eq(old, references))
                    });
                    if !already_counted {
                        count!(arc_slice(references.len()));
                        for reference in references.iter() {
                            count!(string(&reference.asset_id));
                            if let Some(v) = &reference.variant_id {
                                count!(string(v));
                            }
                        }
                    }
                }
            }
        }
        Ok(total)
    }
}

fn add(a: u64, b: u64) -> HeapResult {
    a.checked_add(b).ok_or(CompactModelHeapError::Overflow)
}
fn size(bytes: usize) -> HeapResult {
    u64::try_from(bytes).map_err(|_| CompactModelHeapError::Overflow)
}
fn array<T>(capacity: usize) -> HeapResult {
    size(
        Layout::array::<T>(capacity)
            .map_err(|_| CompactModelHeapError::Overflow)?
            .size(),
    )
}
fn vector<T>(v: &Vec<T>) -> HeapResult {
    array::<T>(v.capacity())
}
fn string(s: &String) -> HeapResult {
    size(s.capacity())
}
fn tree(map: &BTreeMap<String, usize>) -> HeapResult {
    let extra = size(map.len().saturating_sub(1))?
        .checked_mul(96)
        .ok_or(CompactModelHeapError::Overflow)?;
    map.keys()
        .try_fold(add(368, extra)?, |n, key| add(n, string(key)?))
}
fn arc_slice(len: usize) -> HeapResult {
    let data =
        Layout::array::<PackageImageRef>(len).map_err(|_| CompactModelHeapError::Overflow)?;
    let (layout, _) = Layout::new::<[AtomicUsize; 2]>()
        .extend(data)
        .map_err(|_| CompactModelHeapError::Overflow)?;
    size(layout.pad_to_align().size())
}

// Exact original alloc node field types. These are layout witnesses only;
// they never store a tree or mint trusted ModelStructure.
#[allow(dead_code)]
struct Leaf {
    parent: Option<NonNull<()>>,
    parent_idx: MaybeUninit<u16>,
    len: u16,
    keys: [MaybeUninit<String>; 11],
    vals: [MaybeUninit<usize>; 11],
}
#[repr(C)]
#[allow(dead_code)]
struct Internal {
    data: Leaf,
    edges: [MaybeUninit<NonNull<()>>; 12],
}
fn verify_layout() -> Result<(), CompactModelHeapError> {
    check_layout(
        size_of::<usize>(),
        size_of::<Leaf>(),
        size_of::<Internal>(),
        size_of::<PackageImageRef>(),
        align_of::<PackageImageRef>(),
        size_of::<AtomicUsize>(),
        align_of::<AtomicUsize>(),
    )
}
fn check_layout(
    word: usize,
    leaf: usize,
    internal: usize,
    reference: usize,
    reference_align: usize,
    atomic: usize,
    atomic_align: usize,
) -> Result<(), CompactModelHeapError> {
    if (
        word,
        leaf,
        internal,
        reference,
        reference_align,
        atomic,
        atomic_align,
    ) != (8, 368, 464, 48, 8, 8, 8)
    {
        return Err(CompactModelHeapError::UnsupportedLayout);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn record_test_allocation() {
    tests::allocated();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    thread_local! { static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) }; }
    pub(super) fn allocated() {
        let _ = ALLOCATIONS.try_with(|m| {
            if let Some(n) = m.get() {
                m.set(Some(n + 1));
            }
        });
    }
    #[test]
    fn original_layout_and_checked_failures() {
        ALLOCATIONS.with(|m| m.set(Some(0)));
        verify_layout().unwrap();
        assert_eq!(
            array::<u64>(usize::MAX),
            Err(CompactModelHeapError::Overflow)
        );
        assert_eq!(arc_slice(usize::MAX), Err(CompactModelHeapError::Overflow));
        assert_eq!(add(u64::MAX, 1), Err(CompactModelHeapError::Overflow));
        assert_eq!(
            check_layout(4, 368, 464, 48, 8, 8, 8),
            Err(CompactModelHeapError::UnsupportedLayout)
        );
        assert_eq!(ALLOCATIONS.with(|m| m.replace(None)), Some(0));
        let mut arbitrary_empty = BTreeMap::new();
        arbitrary_empty.insert(String::from("_"), 0);
        arbitrary_empty.remove("_");
        assert_eq!(tree(&arbitrary_empty), Ok(368));
        println!(
            "compact original x64 leaf={} internal={} reference={} arc1={}",
            size_of::<Leaf>(),
            size_of::<Internal>(),
            size_of::<PackageImageRef>(),
            arc_slice(1).unwrap()
        );
    }
}
