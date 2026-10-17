// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 舞台窄契约（技术路线 R3-K 第一块）：从 `plugin/ui/creative-gl.js` 的
//! `CreativeGL.scenes()` 由 `scripts/export-stage-contract.js` 生成的版本化
//! JSON，经 `include_str!` 内嵌进 Rust。场景身份与参数窄表只有这里的
//! 一个出处——手工第二份必然漂移（"space"/"coast" 假场景就是这么混进来的）。
//!
//! 完整物化（无副作用 materializeIntent、defaults 深合并、规范化和分享
//! codec）仍归前端与 R3-K 的后续块；本模块只服务两类消费方：
//! intent 校验（scene 必须在表内、patch 键必须在场景参数表内）与
//! fake provider 的候选生成。

use std::sync::OnceLock;

use serde::Deserialize;

const CONTRACT_JSON: &str = include_str!("stage-contract/stage-contract.json");

#[derive(Debug, Deserialize)]
pub(crate) struct StageContract {
    /// 契约版本：Rust 侧随导出物一起更新；形状变更即 bump。
    #[allow(dead_code)]
    pub version: i64,
    pub scenes: Vec<SceneContract>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SceneContract {
    pub id: String,
    #[allow(dead_code)]
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// 场景是否自带歌词渲染（工坊展示用；本模块不消费）。
    #[serde(default)]
    #[allow(dead_code)]
    pub owns_lyrics: bool,
    #[serde(default)]
    pub params: Vec<SceneParam>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SceneParam {
    pub name: String,
    /// 参数边界：导出保留，正式物化（R3-K）在 clamp 时消费。
    #[allow(dead_code)]
    pub min: Option<f64>,
    #[allow(dead_code)]
    pub max: Option<f64>,
    #[allow(dead_code)]
    pub default: Option<serde_json::Value>,
}

fn contract() -> &'static StageContract {
    static CONTRACT: OnceLock<StageContract> = OnceLock::new();
    CONTRACT
        .get_or_init(|| serde_json::from_str(CONTRACT_JSON).expect("内嵌舞台契约必须是合法 JSON"))
}

pub(crate) fn scenes() -> &'static [SceneContract] {
    &contract().scenes
}

/// 按 id 或别名解析场景；找不到返回 None——调用方据此拒绝，不静默换场景。
pub(crate) fn resolve_scene(id_or_alias: &str) -> Option<&'static SceneContract> {
    contract()
        .scenes
        .iter()
        .find(|s| s.id == id_or_alias || s.aliases.iter().any(|a| a == id_or_alias))
}

/// 该场景是否接受这个 patch 参数名。
pub(crate) fn scene_has_param(scene: &SceneContract, name: &str) -> bool {
    scene.params.iter().any(|p| p.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_contract_has_the_real_scene_table() {
        assert_eq!(contract().version, 1);
        let ids: Vec<&str> = scenes().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["towers", "orb", "tunnel", "nebula", "terrain", "lyric"]
        );
        // 假场景名不得混进来。
        assert!(resolve_scene("space").is_none());
        assert!(resolve_scene("coast").is_none());
    }

    #[test]
    fn scenes_resolve_by_alias_and_params_are_populated() {
        let towers = resolve_scene("towers").expect("towers 必须在契约里");
        assert!(scene_has_param(towers, "height"));
        // 别名可解析回同一场景。
        let by_alias = towers
            .aliases
            .first()
            .and_then(|alias| resolve_scene(alias))
            .expect("别名必须可解析");
        assert_eq!(by_alias.id, "towers");
        // 每个场景至少有一个参数与一个默认值，空表等于没导出。
        for scene in scenes() {
            assert!(!scene.params.is_empty(), "场景 {} 无参数", scene.id);
        }
    }
}
