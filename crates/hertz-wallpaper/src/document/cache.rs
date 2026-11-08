// SPDX-License-Identifier: MIT
//! Bounded pure semantic cache. Serialized bytes describe retained data, not a
//! physical RAM guarantee. External consumers keep immutable data through Arc.
use std::collections::{BTreeMap, VecDeque};
use std::io::Write;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{invalid, CompiledDocument, PublicTarget, ResourceUse};
use crate::properties::{validate_property_value, PropertyType};
use crate::{PackageError, Result};

pub struct SemanticCache {
    entries: VecDeque<(String, Arc<CompiledDocument>, usize)>,
    max_entries: usize,
    max_serialized_bytes: usize,
    serialized_bytes: usize,
}

impl SemanticCache {
    pub fn new(max_entries: usize, max_serialized_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries,
            max_serialized_bytes,
            serialized_bytes: 0,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Arc<CompiledDocument>> {
        let index = self.entries.iter().position(|(entry, _, _)| entry == key)?;
        let entry = self.entries.remove(index).expect("located entry");
        let result = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(result)
    }

    pub fn insert(&mut self, value: CompiledDocument) -> Result<Arc<CompiledDocument>> {
        let key = value.ir().semantic_key().to_owned();
        if let Some(existing) = self.get(&key) {
            return Ok(existing);
        }
        let bytes = value
            .normalized_bytes()
            .len()
            .checked_mul(2)
            .and_then(|length| {
                serde_json::to_vec(value.ir())
                    .ok()
                    .and_then(|ir| length.checked_add(ir.len()))
            })
            .ok_or_else(|| invalid("语义缓存计量溢出"))?;
        let value = Arc::new(value);
        if self.max_entries == 0 || bytes > self.max_serialized_bytes {
            return Ok(value);
        }
        while self.entries.len() >= self.max_entries
            || self.serialized_bytes > self.max_serialized_bytes - bytes
        {
            let Some((_, _, retired_bytes)) = self.entries.pop_front() else {
                break;
            };
            self.serialized_bytes -= retired_bytes;
        }
        self.serialized_bytes += bytes;
        self.entries.push_back((key, Arc::clone(&value), bytes));
        Ok(value)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn serialized_bytes(&self) -> usize {
        self.serialized_bytes
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.serialized_bytes = 0;
    }
}

/// Immutable defaults plus validated public overrides for one semantic IR.
/// The compiler remains the owner of targets and resource-slot semantics.
/// Planners consume this value when evaluating final text/particle costs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalPublicValues {
    semantic_key: String,
    values: BTreeMap<String, Value>,
    resource_uses: Vec<ResourceUse>,
}

impl FinalPublicValues {
    pub fn semantic_key(&self) -> &str {
        &self.semantic_key
    }

    pub fn values(&self) -> &BTreeMap<String, Value> {
        &self.values
    }

    pub fn resource_uses(&self) -> &[ResourceUse] {
        &self.resource_uses
    }
}

impl CompiledDocument {
    /// Resolve only public IDs declared by this compiled document. This is pure
    /// planning input, not a runtime state or permission to present Composition.
    pub fn final_public_values(
        &self,
        overrides: &BTreeMap<String, Value>,
    ) -> Result<FinalPublicValues> {
        let public = self.ir().public_properties();
        if overrides.len() > public.len()
            || overrides
                .keys()
                .any(|id| !public.iter().any(|property| property.descriptor.id == *id))
        {
            return Err(PackageError::new(
                "invalid_property_value",
                "最终公开参数包含未声明的 id",
            ));
        }
        let mut values = BTreeMap::new();
        let mut numeric_values: Vec<_> = self
            .ir()
            .numeric_slots()
            .iter()
            .map(|slot| slot.value)
            .collect();
        let mut resource_uses = self.ir().resource_uses().to_vec();
        for property in public {
            let descriptor = &property.descriptor;
            let value = overrides.get(&descriptor.id).unwrap_or(&descriptor.default);
            validate_property_value(descriptor, value)?;
            if let PublicTarget::Numeric { slot } = &property.target {
                let target_slot = &self.ir().numeric_slots()[*slot];
                if !value.as_f64().is_some_and(|number| {
                    number >= target_slot.min
                        && number <= target_slot.max
                        && (!target_slot.integer || number.fract() == 0.0)
                }) {
                    return Err(PackageError::new(
                        "invalid_property_value",
                        format!("最终公开数值与标量/向量分量槽不匹配：{}", descriptor.id),
                    ));
                }
                numeric_values[*slot] = value.as_f64().expect("validated finite number");
            }
            if let PublicTarget::Asset { node_index, field } = &property.target {
                let asset_id = value.as_str().expect("validated asset id").to_owned();
                if let Some(resource) = resource_uses.iter_mut().find(|resource| {
                    resource.node_index == Some(*node_index) && resource.field == *field
                }) {
                    resource.asset_id = asset_id;
                } else {
                    // A public default can populate an optional author slot.
                    let node = &self.ir().nodes()[*node_index];
                    let schema = super::catalog::composition_catalog()
                        .definitions
                        .nodes
                        .iter()
                        .find(|schema| schema.node_type == node.node_type)
                        .expect("compiled node schema");
                    resource_uses.push(ResourceUse {
                        asset_id,
                        node_index: Some(*node_index),
                        effect_index: None,
                        field: field.clone(),
                        usage: schema.assets[field].usage.clone(),
                    });
                }
            }
            // Public numbers are scalar, including a declared vector component.
            // Normalize equivalent numeric spellings and signed zero once.
            let value = if descriptor.property_type == PropertyType::Number {
                let number = value.as_f64().expect("validated finite number");
                Value::from(if number == 0.0 { 0.0 } else { number })
            } else {
                value.clone()
            };
            values.insert(descriptor.id.clone(), value);
        }
        // Validate the combined final slots after all defaults and overrides,
        // so changing both endpoints is evaluated as one pure input.
        for node in self.ir().nodes() {
            if node.node_type == "video" {
                super::compile::validate_video_loop_range(
                    numeric_values[node.property_slots["loopStartMs"][0]],
                    Some(numeric_values[node.property_slots["loopEndMs"][0]]),
                )?;
            }
        }
        let final_values = FinalPublicValues {
            semantic_key: self.ir().semantic_key().to_owned(),
            values,
            resource_uses,
        };
        serde_json::to_writer(
            IdentityWriter {
                hash: Sha256::new(),
                written: 0,
            },
            &final_values,
        )
        .map_err(|error| invalid(format!("最终公开参数无效或超过 1 MiB：{error}")))?;
        Ok(final_values)
    }
}

/// These facts are constructed by the native resolver/planner, never accepted
/// in an author Document. No device qualification is inferred from a key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAssetIdentity {
    pub content_key: String,
    pub decode_options_hash: String,
    pub adapter_version: u32,
    pub dependency_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetIdentity {
    pub public_values: FinalPublicValues,
    pub resolved_assets: BTreeMap<String, ResolvedAssetIdentity>,
    pub capability_digest: String,
    pub output_width: u32,
    pub output_height: u32,
    pub effective_budget_fps: f64,
    pub budget_allocation_revision: u64,
}

impl TargetIdentity {
    pub fn cache_key(&self, compiled: &CompiledDocument) -> Result<String> {
        if self.public_values.semantic_key() != compiled.ir().semantic_key() {
            return Err(invalid("最终公开参数来自不同的已编译文档"));
        }
        if self.output_width == 0
            || self.output_height == 0
            || self.output_width > 16384
            || self.output_height > 16384
            || !self.effective_budget_fps.is_finite()
            || !(0.0..=60.0).contains(&self.effective_budget_fps)
            || !crate::valid_sha256_hex(&self.capability_digest)
            || self.resolved_assets.len() > crate::MAX_FILES
        {
            return Err(invalid("目标缓存身份的尺寸、能力或预算无效"));
        }
        for requirement in self.public_values.resource_uses() {
            if !self.resolved_assets.contains_key(&requirement.asset_id) {
                return Err(invalid("目标缓存身份缺少已引用资源"));
            }
        }
        for (id, asset) in &self.resolved_assets {
            if !crate::valid_local_id(id)
                || asset.content_key.is_empty()
                || asset.content_key.len() > 512
                || !crate::valid_sha256_hex(&asset.decode_options_hash)
                || asset.adapter_version == 0
                || asset.dependency_keys.len() > crate::MAX_FILES
                || asset.dependency_keys.iter().any(|(key, digest)| {
                    key.is_empty() || key.len() > 512 || !crate::valid_sha256_hex(digest)
                })
            {
                return Err(invalid("解析资源身份或解码合同不完整"));
            }
        }
        let mut hash = Sha256::new();
        hash.update(compiled.ir().semantic_key());
        hash.update([0]);
        let mut writer = IdentityWriter { hash, written: 0 };
        serde_json::to_writer(&mut writer, self)
            .map_err(|error| invalid(format!("目标缓存身份无效或超过 1 MiB：{error}")))?;
        Ok(format!("{:x}", writer.hash.finalize()))
    }
}

struct IdentityWriter {
    hash: Sha256,
    written: usize,
}
impl Write for IdentityWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next = self
            .written
            .checked_add(bytes.len())
            .filter(|size| *size <= super::MAX_DOCUMENT_BYTES)
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "identity byte limit")
            })?;
        self.hash.update(bytes);
        self.written = next;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
