// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 内置场景资格目录合同（设计 §3.2/§5.2）。
//!
//! `contracts/catalog.json` 由 `scripts/export-wallpaper-contracts.mjs` 从
//! tools/space-stage 的真实注册定义导出，禁止手改。registryHash 对文件内
//! `scenes` 值的原始字节求 SHA-256（导出器与 Rust 用同一字节段，规避两套
//! JSON 规范化实现），本模块加载时自校验；哈希不符视为构建产物过期。

use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::json::{check_bounded_json, top_level_raw_value};
use crate::{valid_sha256_hex, PackageError, Result};

const CATALOG_BYTES: &[u8] = include_bytes!("../contracts/catalog.json");
// Composition resource buffers add one scalar level below the original scene
// metadata. This generated catalog bound does not change author JSON limits.
const CATALOG_MAX_DEPTH: usize = 9;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CatalogFile {
    schema_version: u32,
    registry_hash: String,
    #[serde(default)]
    scenes: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct CatalogContract {
    pub schema_version: u32,
    pub registry_hash: String,
    /// 注册定义的纯 metadata（id/label/stateVersion/camera/params/capabilities/…）。
    /// P1-04 的「内置资格从 registry 派生」在本合同之上实现。
    pub scenes: Vec<serde_json::Value>,
}

impl CatalogContract {
    /// 按 id 查找场景定义。
    pub fn scene(&self, id: &str) -> Option<&serde_json::Value> {
        self.scenes
            .iter()
            .find(|scene| scene.get("id").and_then(|value| value.as_str()) == Some(id))
    }

    pub fn scene_ids(&self) -> Vec<&str> {
        self.scenes
            .iter()
            .filter_map(|scene| scene.get("id").and_then(|value| value.as_str()))
            .collect()
    }
}

/// 进程内唯一合同实例；构建产物固定，失败即 panic（见 load）。
pub fn catalog() -> &'static CatalogContract {
    static CONTRACT: OnceLock<CatalogContract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        parse_catalog(CATALOG_BYTES)
            .expect("contracts/catalog.json 必须通过自校验（生成物过期请重跑导出器）")
    })
}

/// 校验并解析一份目录合同（导出器 `--check` 与测试复用同一实现）。
pub fn parse_catalog(bytes: &[u8]) -> Result<CatalogContract> {
    check_bounded_json(bytes, CATALOG_MAX_DEPTH)?;
    let file: CatalogFile = serde_json::from_slice(bytes).map_err(|error| {
        PackageError::new(
            "invalid_catalog",
            format!("catalog.json 结构不合法：{error}"),
        )
    })?;
    if file.schema_version != 1 {
        return Err(PackageError::new(
            "unsupported_catalog",
            format!("catalog schemaVersion={} 只接受 1", file.schema_version),
        ));
    }
    if !valid_sha256_hex(&file.registry_hash) {
        return Err(PackageError::new(
            "invalid_hash",
            "registryHash 必须是 64 位小写十六进制",
        ));
    }
    let range = top_level_raw_value(bytes, "scenes")
        .ok_or_else(|| PackageError::new("invalid_catalog", "catalog.json 缺少 scenes 字段"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes[range.start..range.end]);
    let digest = format!("{:x}", hasher.finalize());
    if digest != file.registry_hash {
        return Err(PackageError::new(
            "registry_hash_mismatch",
            format!(
                "scenes 字节段哈希 {digest} 与 registryHash {} 不符",
                file.registry_hash
            ),
        ));
    }
    Ok(CatalogContract {
        schema_version: file.schema_version,
        registry_hash: file.registry_hash,
        scenes: file.scenes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid_and_hashed() {
        let contract = catalog();
        assert_eq!(contract.schema_version, 1);
        assert!(contract.scene_ids().contains(&"zodiac"));
        assert!(contract.scene("coast").is_some());
        // 场景定义来自真实 registry：至少包含桌面九场景 id。
        for id in [
            "zodiac",
            "coast",
            "butterfly-vortex",
            "phoenix-vortex",
            "reactor",
            "particle-silk",
            "gravity-sphere",
            "warp-tunnel",
            "prism-galaxy",
        ] {
            assert!(contract.scene(id).is_some(), "目录缺少 {id}");
        }
    }

    #[test]
    fn tampered_scenes_break_the_hash() {
        let mut bytes = CATALOG_BYTES.to_vec();
        // 在 scenes 数组内追加一个字符，registryHash 必须立刻失配。
        let range = top_level_raw_value(&bytes, "scenes").unwrap();
        bytes.insert(range.end - 1, b' ');
        let error = parse_catalog(&bytes).unwrap_err();
        assert_eq!(error.code, "registry_hash_mismatch");
    }

    #[test]
    fn catalog_depth_remains_bounded_with_composition_metadata() {
        let scene = catalog().scene("spectrum-towers").unwrap();
        let composition = &scene["composition"];
        assert_eq!(composition["adapterId"], "builtin-scene");
        assert_eq!(
            composition["qualities"]["low"]["sourceResources"]["cpuPeakBytes"],
            90248
        );
        let mut nested = serde_json::Value::Null;
        for _ in 0..CATALOG_MAX_DEPTH {
            nested = serde_json::json!([nested]);
        }
        let excessive = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "registryHash": "0".repeat(64), "scenes": [nested]
        }))
        .unwrap();
        assert_eq!(
            parse_catalog(&excessive).unwrap_err().code,
            "manifest_depth"
        );
    }
}
