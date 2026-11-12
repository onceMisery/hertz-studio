// SPDX-License-Identifier: MIT
//! Complete borrowed native facts. No internal image Arc owner is lent.
// The loader gates remain closed; these complete getters are its future input.
#![allow(dead_code)]
use hertz_wallpaper::{
    model_binary::CompactCheckedGlbResource,
    model_container::BinaryChunk,
    model_structure::{
        ModelAccessor, ModelAnimation, ModelBufferView, ModelImage, ModelMesh, ModelNode,
        ModelScene, ModelSkin, ModelSkinBinding, ModelStaticLoaderFields, PackageImageRef,
    },
};

#[derive(Clone, Copy)]
pub(crate) struct NativeModelFacts<'a> {
    owner: &'a CompactCheckedGlbResource,
}
impl<'a> NativeModelFacts<'a> {
    pub(super) fn new(owner: &'a CompactCheckedGlbResource) -> Self {
        Self { owner }
    }
    pub(crate) fn bytes(self) -> u64 {
        self.owner.bytes()
    }
    pub(crate) fn json_bytes(self) -> u64 {
        self.owner.json_bytes()
    }
    pub(crate) fn binary(self) -> Option<&'a BinaryChunk> {
        self.owner.binary()
    }
    pub(crate) fn sha256(self) -> &'a [u8; 32] {
        self.owner.sha256()
    }
    pub(crate) fn source_path(self) -> &'a str {
        self.owner.source_path()
    }
    pub(crate) fn checked_accessors(self) -> usize {
        self.owner.checked_accessors()
    }
    pub(crate) fn unique_layouts(self) -> usize {
        self.owner.unique_layouts()
    }
    pub(crate) fn checked_elements(self) -> u64 {
        self.owner.checked_elements()
    }
    pub(crate) fn checked_components(self) -> u64 {
        self.owner.checked_components()
    }
    pub(crate) fn structure(self) -> NativeModelStructure<'a> {
        let s = self.owner.structure();
        NativeModelStructure {
            buffer_views: &s.buffer_views,
            accessors: &s.accessors,
            meshes: &s.meshes,
            images: NativeModelImages(s.images.iter()),
            animations: &s.animations,
            skins: &s.skins,
            skin_bindings: &s.skin_bindings,
            skin_binding_pair_refs: s.skin_binding_pair_refs,
            nodes: &s.nodes,
            scenes: &s.scenes,
            default_scene: s.default_scene,
            buffer_byte_length: s.buffer_byte_length,
            material_count: s.material_count,
            texture_count: s.texture_count,
            sampler_count: s.sampler_count,
            camera_count: s.camera_count,
            static_loader_fields: s.static_loader_fields,
            node_morph_weights: &s.node_morph_weights,
            mesh_triangles_upper_bound: s.mesh_triangles_upper_bound,
            instantiated_triangles_upper_bound: s.instantiated_triangles_upper_bound,
            binary_content_validated: s.binary_content_validated,
        }
    }
}

#[derive(Clone)]
pub(crate) struct NativeModelStructure<'a> {
    pub(crate) buffer_views: &'a [ModelBufferView],
    pub(crate) accessors: &'a [ModelAccessor],
    pub(crate) meshes: &'a [ModelMesh],
    pub(crate) images: NativeModelImages<'a>,
    pub(crate) animations: &'a [ModelAnimation],
    pub(crate) skins: &'a [ModelSkin],
    pub(crate) skin_bindings: &'a [ModelSkinBinding],
    pub(crate) skin_binding_pair_refs: u64,
    pub(crate) nodes: &'a [ModelNode],
    pub(crate) scenes: &'a [ModelScene],
    pub(crate) default_scene: Option<usize>,
    pub(crate) buffer_byte_length: Option<u64>,
    pub(crate) material_count: usize,
    pub(crate) texture_count: usize,
    pub(crate) sampler_count: usize,
    pub(crate) camera_count: usize,
    pub(crate) static_loader_fields: ModelStaticLoaderFields,
    pub(crate) node_morph_weights: &'a [Option<Vec<f64>>],
    pub(crate) mesh_triangles_upper_bound: u64,
    pub(crate) instantiated_triangles_upper_bound: u64,
    pub(crate) binary_content_validated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeModelImage<'a> {
    Package {
        path: &'a str,
        mime: &'a str,
        bytes: u64,
        sha256: &'a str,
        references: &'a [PackageImageRef],
    },
    Embedded {
        buffer_view: usize,
        range: &'a BinaryChunk,
        mime: &'a str,
    },
}
impl<'a> From<&'a ModelImage> for NativeModelImage<'a> {
    fn from(image: &'a ModelImage) -> Self {
        match image {
            ModelImage::Package {
                path,
                mime,
                bytes,
                sha256,
                references,
            } => Self::Package {
                path,
                mime,
                bytes: *bytes,
                sha256,
                references,
            },
            ModelImage::Embedded {
                buffer_view,
                range,
                mime,
            } => Self::Embedded {
                buffer_view: *buffer_view,
                range,
                mime,
            },
        }
    }
}
#[derive(Clone)]
pub(crate) struct NativeModelImages<'a>(std::slice::Iter<'a, ModelImage>);
impl<'a> Iterator for NativeModelImages<'a> {
    type Item = NativeModelImage<'a>;
    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(Into::into)
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.0.size_hint()
    }
}
impl DoubleEndedIterator for NativeModelImages<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        self.0.next_back().map(Into::into)
    }
}
impl ExactSizeIterator for NativeModelImages<'_> {}
impl std::iter::FusedIterator for NativeModelImages<'_> {}
