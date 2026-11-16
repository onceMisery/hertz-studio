// SPDX-License-Identifier: MIT
//! AI composition metadata and output contract (design §19.3).
//!
//! The service receives aliases and necessary numeric metadata, never local
//! identities or bytes. Compilation here checks author structure against the
//! published catalog using a private synthetic manifest. Its resource entries
//! are placeholders: this result proves no file truth, license, execution
//! permission, installation eligibility, or per-target rendering budget.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::document::{self, catalog::composition_catalog, CompiledDocument, Document, Operation};
use crate::json::check_bounded_json;
use crate::{
    AssetDescriptor, AssetKind, Content, FileEntry, License, Manifest, PackageError, Permissions,
    Result,
};

use super::{invalid, WallpaperGenerationKind};

/// Entire asset-set control JSON, including its `assets` header.
pub const MAX_ASSET_SET_BYTES: usize = 8 * 1024;
/// At least one selected asset is required; each alias is a local ID of ≤64 bytes.
pub const MAX_ASSETS: usize = 32;
/// Raster dimensions follow the existing media probe and texture contract.
pub const MAX_ASSET_EDGE: u32 = 16_384;
pub const MAX_OUTPUT_BYTES: usize = super::MAX_OUTPUT_BYTES;
pub const MAX_OUTPUT_DEPTH: usize = document::MAX_DOCUMENT_DEPTH;
pub const MAX_NODES: usize = 32;
pub const MAX_EFFECTS: usize = 8;
pub const MAX_TRACKS: usize = 16;
pub const MAX_BINDINGS: usize = 16;

/// Privacy-preserving selected resource description. Aliases must be temporary
/// local IDs, not filenames, paths, URLs, titles, or persistent asset identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetMetadata {
    pub alias: String,
    pub kind: AssetKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetSet {
    pub assets: Vec<AssetMetadata>,
}

impl AssetSet {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_ASSET_SET_BYTES {
            return Err(invalid("素材集 metadata 超过 8 KiB"));
        }
        check_bounded_json(bytes, 4)?;
        let set: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("素材集只接受 assets、alias、kind 和必要数值字段"))?;
        set.validate()?;
        Ok(set)
    }

    pub fn validate(&self) -> Result<()> {
        if self.assets.is_empty() || self.assets.len() > MAX_ASSETS {
            return Err(invalid("素材集必须有 1–32 项"));
        }
        let mut aliases = BTreeSet::new();
        for asset in &self.assets {
            if !crate::valid_local_id(&asset.alias) || !aliases.insert(&asset.alias) {
                return Err(invalid("素材别名必须是唯一的 64 字节以内局部 ID"));
            }
            match (asset.kind, asset.width, asset.height) {
                (
                    AssetKind::Image | AssetKind::Video | AssetKind::Texture,
                    Some(width),
                    Some(height),
                ) if (1..=MAX_ASSET_EDGE).contains(&width)
                    && (1..=MAX_ASSET_EDGE).contains(&height) => {}
                (AssetKind::Vector, Some(width), Some(height)) if width > 0 && height > 0 => {}
                (AssetKind::Font | AssetKind::Model | AssetKind::Vector, None, None) => {}
                _ => {
                    return Err(invalid(
                        "素材尺寸须成对提供；光栅为 1–16384，vector 为正整数，font/model 不含尺寸",
                    ))
                }
            }
            match (asset.kind, asset.duration_ms) {
                (AssetKind::Video, Some(duration)) if duration > 0 => {}
                (AssetKind::Video, _) => return Err(invalid("video 素材需要正整数 durationMs")),
                (_, None) => {}
                _ => return Err(invalid("只有 video 素材允许 durationMs")),
            }
        }
        if self.sorted_bytes()?.len() > MAX_ASSET_SET_BYTES {
            return Err(invalid("素材集 metadata 超过 8 KiB"));
        }
        Ok(())
    }

    /// Canonical JSON sorts by alias and uses the fixed metadata field order.
    /// Missing optional fields are omitted; parsing explicit nulls yields the
    /// same canonical representation as omitted optional fields.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        self.sorted_bytes()
    }

    pub fn digest(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(self.canonical_bytes()?)))
    }

    fn sorted_bytes(&self) -> Result<Vec<u8>> {
        #[derive(Serialize)]
        struct CanonicalSet<'a> {
            assets: Vec<&'a AssetMetadata>,
        }
        let mut assets: Vec<_> = self.assets.iter().collect();
        assets.sort_unstable_by(|left, right| left.alias.cmp(&right.alias));
        serde_json::to_vec(&CanonicalSet { assets })
            .map_err(|_| invalid("素材集 metadata 无法序列化"))
    }
}

/// Model output owns only the fixed composition tag and author document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositionOutput {
    pub kind: WallpaperGenerationKind,
    pub document: Document,
}

impl CompositionOutput {
    /// Output ingress must use this parser: the 64 KiB limit applies to these
    /// original wire bytes, before serde inserts optional empty collections.
    pub fn parse(bytes: &[u8], assets: &AssetSet) -> Result<Self> {
        check_output_bytes(bytes)?;
        let output: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("组合输出只接受 kind=composition 与 document"))?;
        output.validate(assets)?;
        Ok(output)
    }

    /// Reuses the unchanged document compiler. Its returned IR retains aliases;
    /// native callers must remap and compile against real package metadata, then
    /// satisfy resource/permission/target admission before preview or execution.
    /// This validates a typed document using the native 1 MiB document bound;
    /// it is not wire ingress and must not replace `parse` for provider bytes.
    /// Retained property nesting is checked before serde recursion; serialization
    /// uses a buffer capped at 1 MiB and rejects excess bytes before copying them.
    pub fn validate(&self, assets: &AssetSet) -> Result<CompiledDocument> {
        let bytes = self.checked_document_bytes()?;
        assets.validate()?;
        visit_resources(&self.document, |alias| {
            if assets.assets.iter().any(|asset| asset.alias == alias) {
                Ok(())
            } else {
                Err(invalid("组合资源只能引用本次选定素材别名"))
            }
        })?;
        let manifest = structural_manifest(assets, &self.document, &bytes);
        document::compile_document(&bytes, &manifest)
    }

    /// Maps only published node/effect resource slots. Text and every other
    /// author field are cloned unchanged, even if they contain matching aliases.
    /// This mapping is not an asset existence, kind, license, or permission check.
    /// The mapped document uses the native document bound, not the wire limit.
    pub fn remap_assets(&self, mapping: &BTreeMap<String, String>) -> Result<Document> {
        self.checked_document_bytes()?;
        for (alias, asset_id) in mapping {
            if !crate::valid_local_id(alias) || !crate::valid_local_id(asset_id) {
                return Err(invalid("资源映射的别名与新 assetId 必须是合法局部 ID"));
            }
        }
        visit_resources(&self.document, |alias| {
            if mapping.contains_key(alias) {
                Ok(())
            } else {
                Err(invalid("资源映射缺少组合引用的素材别名"))
            }
        })?;
        let mut document = self.document.clone();
        for values in document
            .nodes
            .iter_mut()
            .map(|node| &mut node.assets)
            .chain(document.effects.iter_mut().map(|effect| &mut effect.assets))
        {
            for alias in values.values_mut() {
                *alias = mapping[alias].clone();
            }
        }
        checked_document_bytes(&document)?;
        Ok(document)
    }

    fn checked_document_bytes(&self) -> Result<Vec<u8>> {
        if self.kind != WallpaperGenerationKind::Composition {
            return Err(invalid("组合输出 kind 必须为 composition"));
        }
        if self.document.nodes.len() > MAX_NODES
            || self.document.effects.len() > MAX_EFFECTS
            || self.document.timeline.tracks.len() > MAX_TRACKS
            || self.document.bindings.len() > MAX_BINDINGS
        {
            return Err(invalid("AI 组合最多 32 节点、8 效果、16 轨道与 16 绑定"));
        }
        checked_document_bytes(&self.document)
    }
}

fn checked_document_bytes(document: &Document) -> Result<Vec<u8>> {
    // Value is the only recursively authored part of this typed schema. Both
    // resource remapping's clone and serde must follow this bounded precheck.
    let mut remaining_values = document::MAX_DOCUMENT_BYTES;
    for properties in document
        .nodes
        .iter()
        .map(|node| &node.properties)
        .chain(document.effects.iter().map(|effect| &effect.properties))
    {
        for value in properties.values() {
            // Document -> nodes/effects -> node/effect -> properties -> value.
            check_value_depth(value, 4, &mut remaining_values)?;
        }
    }
    let mut writer = DocumentWriter::default();
    if serde_json::to_writer(&mut writer, document).is_err() {
        return Err(if writer.exceeded {
            document_too_large()
        } else {
            invalid("组合文档无法序列化")
        });
    }
    let bytes = writer.bytes;
    check_bounded_json(&bytes, document::MAX_DOCUMENT_DEPTH)?;
    Ok(bytes)
}

fn document_too_large() -> PackageError {
    PackageError::new("document_too_large", "组合文档超过 1 MiB")
}

/// Recursion stops before depth 17. Iteration borrows one child at a time and
/// allocates no scratch queue, even for huge flat containers. Every visited
/// Value needs at least one JSON byte, so the visit budget cannot reject a
/// document that satisfies the byte cap, and bounds precheck work as well.
fn check_value_depth(value: &Value, depth: usize, remaining: &mut usize) -> Result<()> {
    if depth > document::MAX_DOCUMENT_DEPTH {
        return Err(PackageError::new("manifest_depth", "JSON 嵌套深度超过 16"));
    }
    *remaining = remaining.checked_sub(1).ok_or_else(document_too_large)?;
    match value {
        Value::Array(values) => {
            for child in values {
                check_value_depth(child, depth + 1, remaining)?;
            }
        }
        Value::Object(values) => {
            for child in values.values() {
                check_value_depth(child, depth + 1, remaining)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Default)]
struct DocumentWriter {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl Write for DocumentWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > document::MAX_DOCUMENT_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("composition document exceeds byte limit"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            // Vec's ordinary geometric growth can overshoot a non-full budget.
            // Explicit growth keeps its reported backing capacity within 1 MiB.
            let capacity = needed.next_power_of_two().min(document::MAX_DOCUMENT_BYTES);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn check_output_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(invalid("组合输出超过 64 KiB"));
    }
    check_bounded_json(bytes, MAX_OUTPUT_DEPTH)
}

/// Resolve resource locations from the same published catalog as the compiler.
/// Directly constructed outputs cannot make remapping traverse unknown slots.
fn visit_resources(document: &Document, mut visit: impl FnMut(&str) -> Result<()>) -> Result<()> {
    let definitions = &composition_catalog().definitions;
    for node in &document.nodes {
        let schema = definitions
            .nodes
            .iter()
            .find(|schema| schema.node_type == node.node_type)
            .ok_or_else(|| invalid("组合资源引用来自未知节点类型"))?;
        if node.state_version != schema.state_version {
            return Err(invalid("组合节点 stateVersion 不支持"));
        }
        visit_asset_map(&node.assets, &schema.assets, &mut visit)?;
    }
    for effect in &document.effects {
        let schema = definitions
            .effects
            .iter()
            .find(|schema| schema.effect_type == effect.effect_type)
            .ok_or_else(|| invalid("组合资源引用来自未知效果类型"))?;
        if effect.state_version != schema.state_version {
            return Err(invalid("组合效果 stateVersion 不支持"));
        }
        visit_asset_map(&effect.assets, &schema.assets, &mut visit)?;
    }
    Ok(())
}

fn visit_asset_map(
    values: &BTreeMap<String, String>,
    schema: &BTreeMap<String, document::catalog::AssetField>,
    visit: &mut impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    for (field, alias) in values {
        if !schema.contains_key(field) || !crate::valid_local_id(alias) {
            return Err(invalid("组合只允许已发布资源槽与合法素材别名"));
        }
        visit(alias)?;
    }
    if schema
        .iter()
        .any(|(field, spec)| spec.required && !values.contains_key(field))
    {
        return Err(invalid("组合缺少已发布的必需资源槽"));
    }
    Ok(())
}

/// This private manifest has no file handles or true asset hashes. Indexed
/// placeholders exist only to reuse manifest and compiler validation without
/// relaxing their real package contracts. It must never escape to installation.
fn structural_manifest(assets: &AssetSet, document: &Document, bytes: &[u8]) -> Manifest {
    let placeholder_hash = format!("{:x}", Sha256::digest(b"metadata-only-placeholder"));
    let mut descriptors = Vec::with_capacity(assets.assets.len());
    let mut files = vec![FileEntry {
        path: "document.json".into(),
        bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        mime: "application/json".into(),
    }];
    for (index, asset) in assets.assets.iter().enumerate() {
        let path = format!("metadata/asset-{index}.bin");
        descriptors.push(AssetDescriptor {
            id: asset.alias.clone(),
            kind: asset.kind,
            source: path.clone(),
            variants: vec![],
        });
        files.push(FileEntry {
            path,
            bytes: 1,
            sha256: placeholder_hash.clone(),
            mime: "application/octet-stream".into(),
        });
    }
    // Explicitly describe declared data inputs for structural validation. These
    // flags grant nothing; native permission admission remains authoritative.
    let mut permissions = Permissions {
        audio_spectrum: false,
        pointer: false,
    };
    for operation in document
        .bindings
        .iter()
        .flat_map(|binding| &binding.program)
    {
        if let Operation::Input { name } = operation {
            permissions.pointer |= matches!(name.as_str(), "pointerX" | "pointerY");
            permissions.audio_spectrum |=
                matches!(name.as_str(), "energy" | "bass" | "mid" | "high")
                    || name.starts_with("spectrum");
        }
    }
    Manifest {
        format_version: 1,
        work_id: "00000000-0000-0000-0000-000000000000".into(),
        version: 1,
        title: "Metadata-only structural validation".into(),
        description: String::new(),
        content: Content::Composition {
            document: "document.json".into(),
        },
        assets: descriptors,
        files,
        properties: vec![],
        permissions,
        license: License {
            code: "none".into(),
            assets: "none".into(),
            attribution: String::new(),
        },
    }
}

#[cfg(test)]
#[path = "composition_tests.rs"]
mod tests;
