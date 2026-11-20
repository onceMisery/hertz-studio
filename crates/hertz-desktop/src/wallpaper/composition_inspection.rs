// SPDX-License-Identifier: MIT
//! Read-only layout facts use the same document compiler and fixed package bytes.
use super::*;

pub(crate) struct LayoutFacts {
    pub reconstructable: bool,
    pub decoders: u32,
}

fn reconstructable(compiled: &CompiledDocument) -> bool {
    let catalog = hertz_wallpaper::document::catalog::composition_catalog();
    compiled.ir().nodes().iter().all(|node| {
        catalog.definitions.nodes.iter().any(|definition| {
            definition.node_type == node.node_type
                && definition.time_model == hertz_wallpaper::document::catalog::TimeModel::Absolute
        })
    }) && compiled.document().effects.iter().all(|effect| {
        catalog
            .definitions
            .effects
            .iter()
            .any(|definition| definition.effect_type == effect.effect_type && !definition.history)
    })
}

pub(crate) fn inspect_layout(
    store: &super::super::assets::AssetStore,
    package: &super::super::assets::StagedPackage,
    properties: &serde_json::Map<String, Value>,
) -> Result<LayoutFacts> {
    let (compiled, values, _pin) = read_document(store, package, properties)?;
    validate_adapters(&compiled)?;
    validate_resource_uses(&compiled, &values, package)?;
    let inputs = store.probe_source_media(package, &AtomicBool::new(false))?;
    let mut videos = BTreeSet::new();
    for usage in values
        .resource_uses()
        .iter()
        .filter(|usage| usage.usage == "video")
    {
        let descriptor = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == usage.asset_id)
            .ok_or_else(|| JobError::new("asset_not_found", "组合视频资源缺失"))?;
        let input = inputs
            .iter()
            .find(|input| input.media.entry.path == descriptor.source)
            .ok_or_else(|| JobError::new("asset_not_found", "组合视频资源不可读"))?;
        let index = usage_node_index(&compiled, usage)
            .ok_or_else(|| JobError::new("adapter_unavailable", "组合视频节点缺失"))?;
        let start = final_number(&compiled, &values, index, "loopStartMs")?;
        let end = final_number(&compiled, &values, index, "loopEndMs")?;
        if input.metadata.container == Container::Image
            || input
                .metadata
                .duration_ms
                .is_none_or(|duration| start < 0.0 || end <= start || end > duration as f64)
        {
            return Err(JobError::new(
                "invalid_video_range",
                "组合视频范围与真实资源不符",
            ));
        }
        // The original media planner shares only identical source bytes and
        // identical absolute playback ranges. Aliased asset IDs do not add slots.
        videos.insert((
            input.media.entry.sha256.clone(),
            start.to_bits(),
            end.to_bits(),
        ));
    }
    Ok(LayoutFacts {
        reconstructable: reconstructable(&compiled),
        decoders: videos.len() as u32,
    })
}

impl PreparedComposition {
    pub(crate) fn mirror_facts(&self) -> Result<LayoutFacts> {
        Ok(LayoutFacts {
            reconstructable: reconstructable(&self.compiled),
            decoders: self.costs()?.decoders,
        })
    }
}
