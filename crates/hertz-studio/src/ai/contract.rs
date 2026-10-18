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

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const CONTRACT_JSON: &str = include_str!("stage-contract/stage-contract.json");

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StageContract {
    pub schema_version: String,
    pub schema_hash: String,
    pub base_preset_hashes: BTreeMap<String, String>,
    pub common_params: Vec<SceneParam>,
    /// 契约版本：Rust 侧随导出物一起更新；形状变更即 bump。
    #[allow(dead_code)]
    pub version: i64,
    pub scenes: Vec<SceneContract>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct SceneContract {
    pub id: String,
    #[allow(dead_code)]
    pub label: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// 场景是否自带歌词渲染（工坊展示用；本模块不消费）。
    #[serde(default, rename = "ownsLyrics")]
    #[allow(dead_code)]
    pub owns_lyrics: bool,
    #[serde(default)]
    pub params: Vec<SceneParam>,
}

#[derive(Debug, Deserialize, Serialize)]
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

/// StageIntent 候选校验（受控入口 §8.1）：白名单顶层键、深度 ≤ 8、
/// 总大小 ≤ 16 KiB、version/scene 形状。非法输出任务失败、不产提案。
pub(crate) fn validate_intent(intent: &Value) -> Result<(), String> {
    let serialized = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
    if serialized.len() > 16_384 {
        return Err("intent 超过 16 KiB 上限".into());
    }
    const TOP: &[&str] = &["version", "scene", "patch", "director", "hand", "ruleIds"];
    let Value::Object(map) = intent else {
        return Err("intent 必须是对象".into());
    };
    for key in map.keys() {
        if !TOP.contains(&key.as_str()) {
            return Err(format!("intent 含未知顶层键: {key}"));
        }
    }
    if map.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("intent.version 必须是 1".into());
    }
    // scene 必须是前端可消费的规范 ID，patch 路径必须落在该场景的
    // 参数表内——结构合法但指向不存在参数的候选在这里失败，不假装成功。
    let scene = match map.get("scene") {
        Some(Value::String(scene)) if !scene.is_empty() && scene.len() <= 64 => scene,
        _ => return Err("intent.scene 必须是非空短字符串".into()),
    };
    let scene_def =
        resolve_scene(scene).ok_or_else(|| format!("intent.scene 不在当前场景契约内: {scene}"))?;
    if scene_def.id != *scene {
        return Err("intent.scene 必须使用规范场景 ID".into());
    }
    if let Some(Value::Object(patch)) = map.get("patch") {
        for (key, value) in patch {
            if !contract().common_params.iter().any(|p| p.name == *key)
                && !key
                    .strip_prefix("sc.")
                    .is_some_and(|name| scene_has_param(scene_def, name))
            {
                return Err(format!(
                    "intent.patch 含场景 {} 未登记的参数: {key}",
                    scene_def.id
                ));
            }
            if !value.as_f64().is_some_and(f64::is_finite) {
                return Err(format!("intent.patch 参数必须是有限数值: {key}"));
            }
        }
    }
    if map.get("director").is_some_and(|v| !v.is_boolean()) {
        return Err("intent.director 必须是布尔值".into());
    }
    if let Some(hand) = map.get("hand") {
        if !hand
            .as_object()
            .is_some_and(|h| h.len() == 1 && h.get("on").is_some_and(Value::is_boolean))
        {
            return Err("intent.hand 只能包含布尔值 on".into());
        }
    }
    if let Some(ids) = map.get("ruleIds") {
        if !ids
            .as_array()
            .is_some_and(|ids| ids.iter().all(Value::is_string))
        {
            return Err("intent.ruleIds 必须是字符串数组".into());
        }
    }
    if !matches!(map.get("patch"), Some(Value::Object(_))) {
        return Err("intent.patch 必须是对象".into());
    }
    fn depth(v: &Value, d: usize) -> Result<(), String> {
        if d > 8 {
            return Err("intent 嵌套深度超过 8".into());
        }
        match v {
            Value::Object(map) => {
                for (key, value) in map {
                    if ["__proto__", "prototype", "constructor"].contains(&key.as_str()) {
                        return Err("intent 含危险字段".into());
                    }
                    depth(value, d + 1)?;
                }
                Ok(())
            }
            Value::Array(items) => {
                for value in items {
                    depth(value, d + 1)?;
                }
                Ok(())
            }
            Value::Number(n) => {
                if !n.is_f64() || n.as_f64().is_some_and(|f| f.is_finite()) {
                    Ok(())
                } else {
                    Err("intent 含非有限数值".into())
                }
            }
            _ => Ok(()),
        }
    }
    depth(intent, 0)
}

/// Immutable generation-time envelope; never reconstruct this on proposal reads.
pub(crate) fn artifact(intent: &Value) -> Value {
    let c = contract();
    json!({ "artifactVersion": 1, "mode": "create", "intent": intent,
        "schemaVersion": c.schema_version, "schemaHash": c.schema_hash,
        "basePresetHash": c.base_preset_hashes.get(intent["scene"].as_str().unwrap_or_default()) })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Artifact {
    artifact_version: u32,
    mode: String,
    intent: Value,
    schema_version: String,
    schema_hash: String,
    base_preset_hash: String,
}

pub(crate) fn validate_artifact(input: &Value) -> Result<Value, String> {
    if serde_json::to_vec(input).map_err(|e| e.to_string())?.len() > 16_384 {
        return Err("草稿超过 16 KiB".into());
    }
    let a: Artifact = serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
    validate_intent(&a.intent)?;
    let c = contract();
    if a.artifact_version != 1
        || a.mode != "create"
        || a.schema_version != c.schema_version
        || a.schema_hash != c.schema_hash
        || c.base_preset_hashes
            .get(a.intent["scene"].as_str().unwrap_or_default())
            != Some(&a.base_preset_hash)
    {
        return Err("草稿版本或 hash 与当前舞台不兼容，请重新生成".into());
    }
    Ok(
        json!({ "validationStage": "intent", "validatedIntent": a.intent,
        "schemaVersion": a.schema_version, "schemaHash": a.schema_hash,
        "basePresetHash": a.base_preset_hash, "artifact": input,
        "diagnostics": [], "persisted": false, "applied": false }),
    )
}

pub(crate) fn page(offset: usize, limit: usize) -> Value {
    let c = contract();
    let scenes: Vec<_> = c.scenes.iter().skip(offset).take(limit).collect();
    let hashes: BTreeMap<_, _> = scenes
        .iter()
        .filter_map(|s| {
            c.base_preset_hashes
                .get(&s.id)
                .map(|h| (s.id.clone(), h.clone()))
        })
        .collect();
    json!({ "artifactVersion": 1, "mode": "create", "schemaVersion": c.schema_version,
        "schemaHash": c.schema_hash, "basePresetHashes": hashes, "commonParams": c.common_params,
        "scenes": scenes, "total": c.scenes.len(), "offset": offset,
        "nextOffset": if offset.saturating_add(limit) < c.scenes.len() { Some(offset + limit) } else { None },
        "intentFields": ["version", "scene", "patch", "director", "hand", "ruleIds"],
        "limits": { "maxBytes": 16384, "maxDepth": 8 },
        "persisted": false, "applied": false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifacts_pin_versions_and_only_validate_intents() {
        for scene in scenes() {
            let intent = json!({ "version": 1, "scene": scene.id,
                "patch": { "look.grade": 1, format!("sc.{}", scene.params[0].name): 999999 } });
            let a = artifact(&intent);
            let result = validate_artifact(&a).unwrap();
            assert_eq!(result["validationStage"], "intent");
            assert_eq!(result["persisted"], false);
            assert_eq!(result["applied"], false);
            assert_eq!(result["validatedIntent"], intent);
            assert!(result.get("preset").is_none());
            for field in ["schemaVersion", "schemaHash", "basePresetHash", "mode"] {
                let mut bad = a.clone();
                bad[field] = json!("stale");
                assert!(validate_artifact(&bad).is_err());
            }
            let mut bad = a.clone();
            bad["extra"] = json!(true);
            assert!(validate_artifact(&bad).is_err());
            let mut bad = a;
            bad["intent"]["patch"] = json!({ "sc.__proto__": 1 });
            assert!(validate_artifact(&bad).is_err());
        }
        let p = page(8, 2);
        assert_eq!(p["scenes"].as_array().unwrap().len(), 2);
        assert!(p["nextOffset"].is_null());
        assert!(page(10000, 2)["scenes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn embedded_contract_has_the_real_scene_table() {
        assert_eq!(contract().version, 1);
        let ids: Vec<&str> = scenes().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "towers",
                "orb",
                "tunnel",
                "nebula",
                "terrain",
                "lyric",
                "anime-sky",
                "anime-coast",
                "anime-rail",
                "anime-forest"
            ]
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
