// SPDX-License-Identifier: MIT
//! Small structural edits inside the original WorkDrafts revision transaction.
//! The published composition compiler still validates the final graph and spaces.
use super::{invalid, Result};
use std::collections::BTreeSet;

pub(super) fn reorder<T>(items: &mut [T], ids: &[String], id: impl Fn(&T) -> &str) -> Result<()> {
    let expected: BTreeSet<_> = items.iter().map(&id).collect();
    let supplied: BTreeSet<_> = ids.iter().map(String::as_str).collect();
    if ids.len() != items.len() || supplied.len() != ids.len() || expected != supplied {
        return Err(invalid("顺序必须恰好包含当前全部条目，不得重复或遗漏"));
    }
    for (target, key) in ids.iter().enumerate() {
        let source = items
            .iter()
            .position(|item| id(item) == key)
            .ok_or_else(|| invalid("排序条目不存在"))?;
        items.swap(target, source);
    }
    Ok(())
}

/// `index` is the destination sibling position after removing this node.
/// Root moves replace only root slots; a group's authored child order is separate.
pub(super) fn move_node(
    document: &mut hertz_wallpaper::document::Document,
    node_id: &str,
    parent_id: Option<&str>,
    index: usize,
) -> Result<()> {
    if !document.nodes.iter().any(|node| node.id == node_id) {
        return Err(invalid("移动图层不存在"));
    }
    let parent = parent_id
        .map(|key| {
            let position = document
                .nodes
                .iter()
                .position(|node| node.id == key)
                .ok_or_else(|| invalid("目标图层组不存在"))?;
            if key == node_id || document.nodes[position].node_type != "group" {
                return Err(invalid("父图层必须是其他图层组"));
            }
            Ok(position)
        })
        .transpose()?;
    let count = if let Some(parent) = parent {
        document.nodes[parent]
            .children
            .iter()
            .filter(|key| key.as_str() != node_id)
            .count()
    } else {
        let children: BTreeSet<_> = document
            .nodes
            .iter()
            .flat_map(|node| &node.children)
            .collect();
        document
            .nodes
            .iter()
            .filter(|node| node.id != node_id && !children.contains(&node.id))
            .count()
    };
    if index > count {
        return Err(invalid("目标图层顺序超出当前同组范围"));
    }
    // This is one typed operation: a node never persists with two parents.
    for node in &mut document.nodes {
        node.children.retain(|key| key != node_id);
    }
    if let Some(parent) = parent {
        document.nodes[parent]
            .children
            .insert(index, node_id.to_owned());
    } else {
        let children: BTreeSet<_> = document
            .nodes
            .iter()
            .flat_map(|node| node.children.iter().cloned())
            .collect();
        let slots: Vec<_> = document
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(slot, node)| (!children.contains(&node.id)).then_some(slot))
            .collect();
        let mut roots: Vec<_> = slots
            .iter()
            .map(|slot| document.nodes[*slot].clone())
            .collect();
        let source = roots
            .iter()
            .position(|node| node.id == node_id)
            .ok_or_else(|| invalid("根图层不存在"))?;
        let moving = roots.remove(source);
        roots.insert(index, moving);
        for (slot, node) in slots.into_iter().zip(roots) {
            document.nodes[slot] = node;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "work_drafts_structure_tests.rs"]
mod tests;
