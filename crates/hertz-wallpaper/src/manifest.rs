// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! HWPK v1 manifest 解析与校验（设计 §6.1/§6.2/§6.3）。
//!
//! 校验层次：字节预扫描（重复键/深度/大小）→ 严格反序列化（拒绝未知字段）→
//! 值域与交叉引用（uuid/version/长度/资源引用/声明总量的界）。
//! 单资源 kind 上限按 §6.3 对 asset 的 source 文件执行；派生 variant 文件
//! 不重复计费。properties 使用共享类型化合同，校验默认值、约束、显式目标
//! 和当前内容的 registry / 资源引用（§9.3/§15）。

use std::collections::BTreeMap;

mod heap_bounds;
pub use heap_bounds::ManifestHeapBounds;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::json::check_bounded_json;
use crate::paths::validate_rel_path;
use crate::{
    kind_byte_limit, valid_local_id, valid_sha256_hex, PackageError, Result, MAX_FILES,
    MAX_MANIFEST_BYTES, MAX_MANIFEST_DEPTH, MAX_UNCOMPRESSED_BYTES, MAX_VIDEO_BYTES,
};

/// manifest 必须位于包根的固定名字（§6.1）。
pub const MANIFEST_PATH: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub work_id: String,
    pub version: u32,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub content: Content,
    #[serde(default)]
    pub assets: Vec<AssetDescriptor>,
    pub files: Vec<FileEntry>,
    #[serde(default, deserialize_with = "crate::json::deserialize_literal_maps")]
    pub properties: Vec<serde_json::Map<String, serde_json::Value>>,
    pub permissions: Permissions,
    pub license: License,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Permissions {
    #[serde(default)]
    pub audio_spectrum: bool,
    #[serde(default)]
    pub pointer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct License {
    pub code: String,
    pub assets: String,
    #[serde(default)]
    pub attribution: String,
}

/// content 判别联合（§6.1 表）：kind 与必需字段固定，web 只接受 apiVersion=1。
/// serde 的内部标记枚举不支持 deny_unknown_fields，未知键在
/// `validate_manifest_bytes` 的 Value 层按 `CONTENT_KEYS` 白名单拒绝。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Content {
    Image {
        asset: String,
    },
    Video {
        asset: String,
    },
    Builtin {
        scene_id: String,
        state_version: u32,
        #[serde(default, deserialize_with = "crate::json::deserialize_literal_map")]
        params: serde_json::Map<String, serde_json::Value>,
    },
    Composition {
        document: String,
    },
    Web {
        entry: String,
        api_version: u32,
    },
}

/// 各 content 分支允许的字段（§6.1 表）。
const CONTENT_KEYS: [(&str, &[&str]); 5] = [
    ("image", &["kind", "asset"]),
    ("video", &["kind", "asset"]),
    ("builtin", &["kind", "sceneId", "stateVersion", "params"]),
    ("composition", &["kind", "document"]),
    ("web", &["kind", "entry", "apiVersion"]),
];

fn validate_content_keys(content: &serde_json::Value) -> Result<()> {
    let object = content
        .as_object()
        .ok_or_else(|| PackageError::new("invalid_manifest", "content 必须是对象"))?;
    let kind = object
        .get("kind")
        .and_then(|value| value.as_str())
        .ok_or_else(|| PackageError::new("invalid_manifest", "content.kind 必须是字符串"))?;
    let allowed = CONTENT_KEYS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, keys)| *keys)
        .ok_or_else(|| {
            PackageError::new(
                "unsupported_content",
                format!("content.kind={kind} 不受支持"),
            )
        })?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(PackageError::new(
                "unknown_field",
                format!("content.{kind} 存在未知字段：{key}"),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Image,
    Video,
    Font,
    Model,
    Vector,
    Texture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AssetDescriptor {
    pub id: String,
    pub kind: AssetKind,
    pub source: String,
    #[serde(default)]
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VariantPurpose {
    Preview,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    pub file: String,
    pub purpose: VariantPurpose,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub color_space: Option<String>,
    #[serde(default)]
    pub alpha_mode: Option<String>,
    #[serde(default)]
    pub mip_levels: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub mime: String,
}

impl Manifest {
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.iter().find(|file| file.path == path)
    }

    /// content 引用的资源 id；交叉引用校验与运行时解析共用。
    pub fn content_asset(&self) -> Option<&str> {
        match &self.content {
            Content::Image { asset } | Content::Video { asset } => Some(asset),
            Content::Builtin { .. } => None,
            Content::Composition { .. } | Content::Web { .. } => None,
        }
    }

    /// Composition/Web entry points name indexed package files, not media IDs.
    pub fn content_file(&self) -> Option<&str> {
        match &self.content {
            Content::Composition { document } => Some(document),
            Content::Web { entry, .. } => Some(entry),
            _ => None,
        }
    }
}

/// 从原始字节校验并解析 manifest（§6.1 全部规则）。
pub fn validate_manifest_bytes(bytes: &[u8]) -> Result<Manifest> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(PackageError::new(
            "manifest_too_large",
            format!("manifest 超过 {MAX_MANIFEST_BYTES} 字节上限"),
        ));
    }
    check_bounded_json(bytes, MAX_MANIFEST_DEPTH)?;
    let value = crate::json::literal_value_from_slice(bytes).map_err(|error| {
        PackageError::new("invalid_json", format!("manifest 不是合法 JSON：{error}"))
    })?;
    if let Some(content) = value.get("content") {
        validate_content_keys(content)?;
    }
    let manifest: Manifest = serde_json::from_value(value).map_err(|error| {
        PackageError::new("invalid_manifest", format!("manifest 结构不合法：{error}"))
    })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.format_version != 1 {
        return Err(PackageError::new(
            "unsupported_format",
            format!(
                "formatVersion={} 不受支持，只接受 1",
                manifest.format_version
            ),
        ));
    }
    // workId 必须是标准（连字符小写）UUID 字符串。
    let parsed = Uuid::parse_str(&manifest.work_id).map_err(|_| {
        PackageError::new(
            "invalid_work_id",
            format!("workId 不是合法 UUID：{}", manifest.work_id),
        )
    })?;
    if parsed.to_string() != manifest.work_id {
        return Err(PackageError::new(
            "invalid_work_id",
            format!("workId 必须是标准连字符小写形式：{}", manifest.work_id),
        ));
    }
    if manifest.version == 0 {
        return Err(PackageError::new(
            "invalid_version",
            "version 必须从 1 开始",
        ));
    }
    let title_chars = manifest.title.chars().count();
    if title_chars == 0 || title_chars > 120 {
        return Err(PackageError::new(
            "invalid_title",
            "标题长度必须是 1–120 字符",
        ));
    }
    if manifest.description.chars().count() > 4000 {
        return Err(PackageError::new(
            "invalid_description",
            "描述最多 4000 字符",
        ));
    }
    if manifest.license.code.is_empty() || manifest.license.code.len() > 64 {
        return Err(PackageError::new(
            "invalid_license",
            "license.code 必须是 1–64 字符",
        ));
    }
    if manifest.license.assets.is_empty() || manifest.license.assets.len() > 64 {
        return Err(PackageError::new(
            "invalid_license",
            "license.assets 必须是 1–64 字符",
        ));
    }
    if manifest.license.attribution.len() > 512 {
        return Err(PackageError::new(
            "invalid_license",
            "attribution 最多 512 字符",
        ));
    }
    // A builtin scene's complete state lives in the manifest. Media, web and
    // composition content still require their declared package files.
    if manifest.files.is_empty() && !matches!(manifest.content, Content::Builtin { .. }) {
        return Err(PackageError::new(
            "invalid_manifest",
            "此作品类型的 files 不能为空",
        ));
    }
    if manifest.files.len() > MAX_FILES {
        return Err(PackageError::new(
            "too_many_files",
            format!("文件数超过 {MAX_FILES} 上限"),
        ));
    }
    let mut declared: BTreeMap<String, ()> = BTreeMap::new();
    let mut total_bytes: u64 = 0;
    for file in &manifest.files {
        validate_rel_path(&file.path)?;
        if !valid_sha256_hex(&file.sha256) {
            return Err(PackageError::new(
                "invalid_hash",
                format!("sha256 必须是 64 位小写十六进制：{}", file.path),
            ));
        }
        if file.bytes == 0 {
            return Err(PackageError::new(
                "invalid_size",
                format!("文件字节数必须大于 0：{}", file.path),
            ));
        }
        if !valid_mime(&file.mime) {
            return Err(PackageError::new(
                "invalid_mime",
                format!("mime 必须是形如 image/png 的小写类型：{}", file.mime),
            ));
        }
        if declared.insert(file.path.clone(), ()).is_some() {
            return Err(PackageError::new(
                "duplicate_file",
                format!("files 存在重复路径：{}", file.path),
            ));
        }
        total_bytes = total_bytes
            .checked_add(file.bytes)
            .ok_or_else(|| PackageError::new("invalid_size", "声明字节数溢出"))?;
        if total_bytes > MAX_UNCOMPRESSED_BYTES {
            return Err(PackageError::new(
                "package_too_large",
                "声明解压总量超过 1 GiB 上限",
            ));
        }
        if file.bytes > MAX_VIDEO_BYTES {
            return Err(PackageError::new(
                "invalid_size",
                format!("单文件超过 512 MiB 资源上限：{}", file.path),
            ));
        }
    }
    // 资源描述：id 规则 + 引用必须落在 files 内 + source 受 kind 上限约束。
    let mut asset_ids: BTreeMap<String, ()> = BTreeMap::new();
    for asset in &manifest.assets {
        if !valid_local_id(&asset.id) {
            return Err(PackageError::new(
                "invalid_asset_id",
                format!("资源 id 不符合 [a-z][a-z0-9-]{{0,63}}：{}", asset.id),
            ));
        }
        if asset_ids.insert(asset.id.clone(), ()).is_some() {
            return Err(PackageError::new(
                "duplicate_asset",
                format!("资源 id 重复：{}", asset.id),
            ));
        }
        validate_referenced_file(manifest, &asset.id, &asset.source)?;
        if let Some(entry) = manifest.file(&asset.source) {
            let limit = kind_byte_limit(asset.kind);
            if entry.bytes > limit {
                return Err(PackageError::new(
                    "resource_too_large",
                    format!(
                        "资源 {}（{}）超过单资源上限 {} 字节",
                        asset.id, asset.source, limit
                    ),
                ));
            }
        }
        let mut variant_ids: BTreeMap<String, ()> = BTreeMap::new();
        for variant in &asset.variants {
            if !valid_local_id(&variant.id) {
                return Err(PackageError::new(
                    "invalid_asset_id",
                    format!("variant id 不符合规则：{}", variant.id),
                ));
            }
            if variant_ids.insert(variant.id.clone(), ()).is_some() {
                return Err(PackageError::new(
                    "duplicate_asset",
                    format!("variant id 重复：{}", variant.id),
                ));
            }
            validate_referenced_file(manifest, &variant.id, &variant.file)?;
        }
    }
    // content 引用与 apiVersion。
    match &manifest.content {
        Content::Builtin { scene_id, .. } => {
            if !valid_local_id(scene_id) {
                return Err(PackageError::new(
                    "invalid_scene_id",
                    format!("sceneId 不符合规则：{scene_id}"),
                ));
            }
        }
        Content::Web { api_version: 1, .. } => {}
        Content::Web { api_version, .. } => {
            return Err(PackageError::new(
                "unsupported_api_version",
                format!("web apiVersion 只接受 1：{api_version}"),
            ));
        }
        _ => {}
    }
    if let Some(asset_id) = manifest.content_asset() {
        if !asset_id.is_empty() && !asset_ids.contains_key(asset_id) {
            return Err(PackageError::new(
                "missing_asset",
                format!("content 引用了未声明的资源：{asset_id}"),
            ));
        }
    }
    if let Some(path) = manifest.content_file() {
        validate_referenced_file(manifest, "content", path)?;
        let file = manifest.file(path).expect("verified indexed file");
        let (mime, limit) = match manifest.content {
            Content::Composition { .. } => (
                "application/json",
                crate::document::MAX_DOCUMENT_BYTES as u64,
            ),
            Content::Web { .. } => ("text/html", crate::MAX_TEXT_BYTES),
            _ => unreachable!("file entry content"),
        };
        if file.mime != mime || file.bytes > limit {
            return Err(PackageError::new(
                "invalid_content_file",
                "内容入口 MIME 或字节数不满足合同",
            ));
        }
    }
    crate::properties::validate_properties(manifest)?;
    Ok(())
}

fn validate_referenced_file(manifest: &Manifest, owner: &str, path: &str) -> Result<()> {
    validate_rel_path(path)?;
    if manifest.file(path).is_none() {
        return Err(PackageError::new(
            "missing_file",
            format!("资源 {owner} 引用了未声明的文件：{path}"),
        ));
    }
    Ok(())
}

fn valid_mime(mime: &str) -> bool {
    let (type_part, subtype) = match mime.split_once('/') {
        Some(parts) => parts,
        None => return false,
    };
    if mime.len() > 127 {
        return false;
    }
    let token = |value: &str| {
        !value.is_empty()
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'+' | b'-')
            })
    };
    token(type_part) && token(subtype)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_manifest() -> serde_json::Value {
        serde_json::json!({
            "formatVersion": 1,
            "workId": "c17ed10a-5c55-4a52-85dc-7509f9e88aae",
            "version": 1,
            "title": "静夜",
            "description": "静态图片壁纸",
            "content": { "kind": "image", "asset": "background" },
            "assets": [
                { "id": "background", "kind": "image", "source": "assets/background.png", "variants": [] }
            ],
            "files": [
                {
                    "path": "assets/background.png",
                    "bytes": 70,
                    "sha256": "abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f",
                    "mime": "image/png"
                }
            ],
            "properties": [],
            "permissions": { "audioSpectrum": false, "pointer": false },
            "license": { "code": "none", "assets": "CC0-1.0", "attribution": "" }
        })
    }

    #[test]
    fn doc_fixture_manifest_is_valid() {
        let manifest =
            validate_manifest_bytes(&serde_json::to_vec(&base_manifest()).unwrap()).unwrap();
        assert_eq!(manifest.work_id, "c17ed10a-5c55-4a52-85dc-7509f9e88aae");
        assert_eq!(manifest.content_asset(), Some("background"));
    }

    #[test]
    fn unknown_fields_and_duplicate_keys_are_rejected() {
        let mut value = base_manifest();
        value["legacyField"] = 1.into();
        let error = validate_manifest_bytes(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert_eq!(error.code, "invalid_manifest");
        let raw = br#"{"formatVersion":1,"formatVersion":1}"#;
        assert_eq!(
            validate_manifest_bytes(raw).unwrap_err().code,
            "duplicate_key"
        );
    }

    #[test]
    fn identity_and_bound_violations_map_to_stable_codes() {
        let mut value = base_manifest();
        value["version"] = 0.into();
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "invalid_version"
        );
        let mut value = base_manifest();
        value["title"] = "标".repeat(121).into();
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "invalid_title"
        );
        let mut value = base_manifest();
        value["workId"] = "not-a-uuid".into();
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "invalid_work_id"
        );
        let mut value = base_manifest();
        value["files"][0]["sha256"] =
            "ABC58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f".into();
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "invalid_hash"
        );
        let mut value = base_manifest();
        value["content"] = serde_json::json!({ "kind": "web", "entry": "index", "apiVersion": 2 });
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "unsupported_api_version"
        );
        let mut value = base_manifest();
        value["assets"][0]["source"] = "assets/missing.png".into();
        assert_eq!(
            validate_manifest(&serde_json::from_value(value).unwrap())
                .unwrap_err()
                .code,
            "missing_file"
        );
    }
}
