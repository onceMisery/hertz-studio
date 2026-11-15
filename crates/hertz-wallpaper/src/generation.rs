// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸生成类型化合同（设计 §19.3）。纯数据与确定性验证：请求/输出/产物三张
//! 票据的字段、边界与 builtin 参数对资格目录的严格校验。
//!
//! 本模块不授予任何执行权限——quote/submit、短会话配对与 provider 调用属
//! §19.4/§19.5 的后续切片；`registryHash` 与 `generationSchemaHash` 的跨版本
//! 匹配（仅 hash 完全一致的生成子集上工作）由持有两端的调用方裁决，这里只
//! 验证格式与本地目录成员。模型输出按原样拒绝：未知参数、越界与版本不匹配
//! 都不自动 clamp 后声称原结果有效。

use serde::{Deserialize, Serialize};

use crate::ai::MAX_BRIEF_BYTES;
use crate::json::check_bounded_json;
use crate::{valid_sha256_hex, PackageError, Result};

/// 完整控制 JSON 上界（设计 §19.3：含 brief 最多 4 KiB，控制 JSON 最多 12 KiB，
/// 连同 §14 信封不超过 16 KiB）。
pub const MAX_REQUEST_BYTES: usize = 12 * 1024;
/// 模型结构化输出上界（设计 §19.5：文本结构化响应沿 64 KiB 领域上限）。
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// 生成请求协议版本；不匹配即拒绝，不静默降级字段。
pub const GENERATION_REQUEST_VERSION: u32 = 1;
/// 图像单边上界（设计 §19.3：最长边 4096、像素总数不超过 8 Mi）。
pub const MAX_IMAGE_EDGE: u32 = 4096;
/// 图像像素总数上界。
pub const MAX_IMAGE_PIXELS: u64 = 8 * 1024 * 1024;
/// artifact 字节上界（设计 §19.5：原生接收上限 32 MiB；信封由服务按实际
/// 接收字节构造，模型自报的哈希与大小从不进入本结构）。
pub const MAX_ARTIFACT_BYTES: u64 = 32 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::new("invalid_generation", message)
}

/// 有界标识：非空、不超 64 字节、不含控制字符。
fn valid_bounded_id(value: &str, message: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(invalid(message));
    }
    Ok(())
}

/// 生成输出类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WallpaperGenerationKind {
    Builtin,
    Composition,
    Image,
}

/// 生成目标（设计 §19.3 `WallpaperGeneration`）。serde 的内部 tag 枚举不支持
/// `deny_unknown_fields`，因此用普通结构 + kind 判别：`validate` 强制每个
/// 类别只允许自己的字段集合，其余类别字段出现即拒绝。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WallpaperGeneration {
    pub kind: WallpaperGenerationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_set_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_id: Option<String>,
}

impl WallpaperGeneration {
    fn validate(&self) -> Result<()> {
        match self.kind {
            WallpaperGenerationKind::Builtin => {
                let scene_id =
                    self.required_text("scene_id", "builtin 场景 ID 需为 64 字节以内的非空文本")?;
                if crate::catalog().scene(&scene_id).is_none() {
                    return Err(invalid("builtin 场景不在资格目录内"));
                }
                self.forbids(&["asset_set_id", "width", "height", "quality_id"])?;
            }
            WallpaperGenerationKind::Composition => {
                self.required_text("asset_set_id", "素材集 ID 需为 64 字节以内的非空文本")?;
                self.forbids(&["scene_id", "width", "height", "quality_id"])?;
            }
            WallpaperGenerationKind::Image => {
                let width = self.width.ok_or_else(|| invalid("图像输出缺少 width"))?;
                let height = self.height.ok_or_else(|| invalid("图像输出缺少 height"))?;
                if width == 0
                    || height == 0
                    || width > MAX_IMAGE_EDGE
                    || height > MAX_IMAGE_EDGE
                    || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
                {
                    return Err(invalid("图像尺寸超出最长边 4096 或像素总数 8 Mi 上界"));
                }
                self.required_text("quality_id", "图像质量 ID 需为 64 字节以内的非空文本")?;
                self.forbids(&["scene_id", "asset_set_id"])?;
            }
        }
        Ok(())
    }

    fn required_text(&self, field: &str, message: &str) -> Result<String> {
        let value = match field {
            "scene_id" => &self.scene_id,
            "asset_set_id" => &self.asset_set_id,
            "quality_id" => &self.quality_id,
            _ => &None,
        };
        let Some(value) = value else {
            return Err(invalid(message));
        };
        valid_bounded_id(value, message)?;
        Ok(value.clone())
    }

    fn forbids(&self, fields: &[&str]) -> Result<()> {
        for field in fields {
            let present = match *field {
                "scene_id" => self.scene_id.is_some(),
                "asset_set_id" => self.asset_set_id.is_some(),
                "width" => self.width.is_some(),
                "height" => self.height.is_some(),
                "quality_id" => self.quality_id.is_some(),
                _ => false,
            };
            if present {
                return Err(invalid(format!(
                    "生成目标字段「{field}」不属于当前输出类别"
                )));
            }
        }
        Ok(())
    }
}

/// 生成请求（设计 §19.3 `WallpaperGenerateRequest`）。桌面构造并发往服务，
/// 服务在同一结构上验证；`deny_unknown_fields` 与字节级重复键扫描共同落实
/// 「拒绝重复/未知字段」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WallpaperGenerateRequest {
    pub version: u32,
    pub request_id: String,
    pub brief: String,
    pub output: WallpaperGeneration,
    pub registry_hash: String,
    pub generation_schema_hash: String,
    pub capability_snapshot_id: String,
}

impl WallpaperGenerateRequest {
    /// 从有界 JSON 字节解析并验证完整请求。
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(invalid("生成请求超过 12 KiB"));
        }
        check_bounded_json(bytes, 6)?;
        let request: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("生成请求结构无效"))?;
        request.validate()?;
        Ok(request)
    }

    /// 校验版本、字段边界与 builtin 目标的目录成员。
    pub fn validate(&self) -> Result<()> {
        if self.version != GENERATION_REQUEST_VERSION {
            return Err(invalid("生成请求版本必须为 1"));
        }
        valid_bounded_id(&self.request_id, "生成请求 ID 需为 64 字节以内的非空文本")?;
        if self.brief.len() > MAX_BRIEF_BYTES
            || self
                .brief
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(invalid("生成描述需为 4 KiB 以内文本，不能含不可见控制字符"));
        }
        if !valid_sha256_hex(&self.registry_hash) || !valid_sha256_hex(&self.generation_schema_hash)
        {
            return Err(invalid("生成请求的注册与 schema 哈希需为 64 位十六进制"));
        }
        valid_bounded_id(
            &self.capability_snapshot_id,
            "能力快照 ID 需为 64 字节以内的非空文本",
        )?;
        self.output.validate()
    }
}

/// 模型 builtin 输出（设计 §19.3：`{kind,sceneId,stateVersion,params}`）。
/// 参数严格按资格目录的场景 schema 验证。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinSceneOutput {
    pub kind: WallpaperGenerationKind,
    pub scene_id: String,
    pub state_version: u32,
    pub params: serde_json::Map<String, serde_json::Value>,
}

impl BuiltinSceneOutput {
    /// 从有界 JSON 字节解析并验证模型输出；这是 provider 结果进入导入/预算
    /// 前的第一道确定性门。
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_OUTPUT_BYTES {
            return Err(invalid("模型输出超过 64 KiB 领域上限"));
        }
        check_bounded_json(bytes, 6)?;
        let output: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("模型输出结构无效"))?;
        output.validate()?;
        Ok(output)
    }

    /// 校验 kind、场景存在性、stateVersion 与逐参数 schema。
    pub fn validate(&self) -> Result<()> {
        if self.kind != WallpaperGenerationKind::Builtin {
            return Err(invalid("模型输出类型不是 builtin"));
        }
        valid_bounded_id(&self.scene_id, "builtin 场景 ID 需为 64 字节以内的非空文本")?;
        let scene = crate::catalog()
            .scene(&self.scene_id)
            .ok_or_else(|| invalid("builtin 场景不在资格目录内"))?;
        if scene.get("stateVersion").and_then(|value| value.as_u64())
            != Some(u64::from(self.state_version))
        {
            return Err(invalid("builtin 输出 stateVersion 与资格目录不一致"));
        }
        let definitions = scene
            .get("params")
            .and_then(|value| value.as_object())
            .ok_or_else(|| invalid("资格目录缺少场景参数 schema"))?;
        for (key, value) in &self.params {
            let Some(definition) = definitions.get(key) else {
                return Err(invalid(format!(
                    "builtin 参数「{key}」不是该场景的已发布参数"
                )));
            };
            let kind = definition.get("type").and_then(|value| value.as_str());
            match kind {
                Some("number") => {
                    let Some(raw) = value.as_f64() else {
                        return Err(invalid(format!("builtin 参数「{key}」需为数值")));
                    };
                    if let Some(min) = definition.get("min").and_then(|value| value.as_f64()) {
                        if raw < min {
                            return Err(invalid(format!("builtin 参数「{key}」低于下界")));
                        }
                    }
                    if let Some(max) = definition.get("max").and_then(|value| value.as_f64()) {
                        if raw > max {
                            return Err(invalid(format!("builtin 参数「{key}」超过上界")));
                        }
                    }
                }
                Some("boolean") => {
                    if !value.is_boolean() {
                        return Err(invalid(format!("builtin 参数「{key}」需为布尔")));
                    }
                }
                Some("select") => {
                    let Some(raw) = value.as_str() else {
                        return Err(invalid(format!("builtin 参数「{key}」需为选项字符串")));
                    };
                    let allowed = definition
                        .get("options")
                        .and_then(|value| value.as_array())
                        .ok_or_else(|| invalid("资格目录 select 参数缺少选项表"))?;
                    let option_matches = |option: &serde_json::Value| {
                        option.as_str() == Some(raw)
                            || option.get("value").and_then(|value| value.as_str()) == Some(raw)
                    };
                    if !allowed.iter().any(option_matches) {
                        return Err(invalid(format!("builtin 参数「{key}」不在已发布选项内")));
                    }
                }
                _ => return Err(invalid(format!("builtin 参数「{key}」类型未受支持"))),
            }
        }
        Ok(())
    }
}

/// 生成产物信封（设计 §19.3 `WallpaperArtifact`）。由服务按实际接收字节
/// 构造，原生按同一结构校验后进入导入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WallpaperArtifact {
    pub artifact_id: String,
    pub job_id: String,
    pub kind: WallpaperGenerationKind,
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
    pub registry_hash: String,
    pub generation_schema_hash: String,
    pub expires_at: String,
}

impl WallpaperArtifact {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(invalid("artifact 信封超过 12 KiB"));
        }
        check_bounded_json(bytes, 6)?;
        let artifact: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("artifact 信封结构无效"))?;
        artifact.validate()?;
        Ok(artifact)
    }

    pub fn validate(&self) -> Result<()> {
        valid_bounded_id(&self.artifact_id, "artifact ID 需为 64 字节以内的非空文本")?;
        valid_bounded_id(&self.job_id, "任务 ID 需为 64 字节以内的非空文本")?;
        if !valid_sha256_hex(&self.sha256) {
            return Err(invalid("artifact 哈希需为 64 位十六进制"));
        }
        if self.bytes == 0 || self.bytes > MAX_ARTIFACT_BYTES {
            return Err(invalid("artifact 字节数需在 1 B 到 32 MiB 之间"));
        }
        let mime_allowed = match self.kind {
            WallpaperGenerationKind::Builtin | WallpaperGenerationKind::Composition => {
                self.mime == "application/json"
            }
            WallpaperGenerationKind::Image => {
                matches!(
                    self.mime.as_str(),
                    "image/png" | "image/jpeg" | "image/webp"
                )
            }
        };
        if !mime_allowed {
            return Err(invalid("artifact MIME 与输出类别不匹配"));
        }
        if !valid_sha256_hex(&self.registry_hash) || !valid_sha256_hex(&self.generation_schema_hash)
        {
            return Err(invalid("artifact 的注册与 schema 哈希需为 64 位十六进制"));
        }
        valid_bounded_id(&self.expires_at, "artifact 过期时间需为有界时间文本")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCENE_HASH_A: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const SCENE_HASH_B: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn request(output: serde_json::Value) -> serde_json::Value {
        json!({
            "version": 1,
            "requestId": "req-0001",
            "brief": "安静的深色频谱",
            "output": output,
            "registryHash": SCENE_HASH_A,
            "generationSchemaHash": SCENE_HASH_B,
            "capabilitySnapshotId": "cap-0001",
        })
    }

    #[test]
    fn builtin_request_round_trips_with_catalog_membership() {
        let bytes =
            serde_json::to_vec(&request(json!({"kind":"builtin","sceneId":"coast"}))).unwrap();
        let parsed = WallpaperGenerateRequest::parse(&bytes).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.request_id, "req-0001");
        assert_eq!(parsed.output.kind, WallpaperGenerationKind::Builtin);
        assert_eq!(parsed.output.scene_id.as_deref(), Some("coast"));
        assert_eq!(parsed.output.width, None);
    }

    #[test]
    fn request_rejects_unknown_duplicate_and_out_of_bound_fields() {
        let bytes = serde_json::to_vec(&request(json!({"kind":"builtin","sceneId":"coast"})))
            .unwrap()
            .to_vec();
        let mut unknown = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
        unknown["applied"] = json!(true);
        let err =
            WallpaperGenerateRequest::parse(&serde_json::to_vec(&unknown).unwrap()).unwrap_err();
        assert_eq!(err.code, "invalid_generation");

        let mut duplicate = bytes.clone();
        let marker = b"\"requestId\":\"req-0001\",";
        let position = duplicate
            .windows(marker.len())
            .position(|window| window == marker)
            .unwrap();
        duplicate.splice(position..position, marker.iter().copied());
        assert_eq!(
            WallpaperGenerateRequest::parse(&duplicate)
                .unwrap_err()
                .code,
            "duplicate_key"
        );

        let mut oversized = vec![b'{'];
        oversized.extend(std::iter::repeat_n(b'a', MAX_REQUEST_BYTES));
        oversized.extend_from_slice(b"\"x\":1}");
        assert!(WallpaperGenerateRequest::parse(&oversized).is_err());

        let mut wrong_version = request(json!({"kind":"builtin","sceneId":"coast"}));
        wrong_version["version"] = json!(2);
        assert!(
            WallpaperGenerateRequest::parse(&serde_json::to_vec(&wrong_version).unwrap()).is_err()
        );

        let mut long_brief = request(json!({"kind":"builtin","sceneId":"coast"}));
        long_brief["brief"] = json!("好".repeat(MAX_BRIEF_BYTES / 3 + 1));
        assert!(
            WallpaperGenerateRequest::parse(&serde_json::to_vec(&long_brief).unwrap()).is_err()
        );

        let mut bad_hash = request(json!({"kind":"builtin","sceneId":"coast"}));
        bad_hash["registryHash"] = json!("zz");
        assert!(WallpaperGenerateRequest::parse(&serde_json::to_vec(&bad_hash).unwrap()).is_err());
    }

    #[test]
    fn builtin_output_validates_params_strictly_against_the_catalog() {
        let mut output = json!({
            "kind":"builtin","sceneId":"coast","stateVersion":1,
            "params":{"dust":0.35}
        });
        BuiltinSceneOutput::parse(&serde_json::to_vec(&output).unwrap()).unwrap();

        output["params"]["dust"] = json!(1.5);
        assert_eq!(
            BuiltinSceneOutput::parse(&serde_json::to_vec(&output).unwrap())
                .unwrap_err()
                .code,
            "invalid_generation"
        );

        output["params"]["dust"] = json!(0.2);
        output["params"]["weather"] = json!(true);
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&output).unwrap()).is_err());

        output["params"].as_object_mut().unwrap().remove("weather");
        let mut zodiac = json!({
            "kind":"builtin","sceneId":"zodiac","stateVersion":1,
            "params":{"sign":"aries"}
        });
        BuiltinSceneOutput::parse(&serde_json::to_vec(&zodiac).unwrap()).unwrap();
        zodiac["params"]["sign"] = json!("nope");
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&zodiac).unwrap()).is_err());
        zodiac["params"]["sign"] = json!(1);
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&zodiac).unwrap()).is_err());

        zodiac["stateVersion"] = json!(2);
        zodiac["params"]["sign"] = json!("aries");
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&zodiac).unwrap()).is_err());

        let mut unknown_scene =
            json!({"kind":"builtin","sceneId":"no-such","stateVersion":1,"params":{}});
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&unknown_scene).unwrap()).is_err());

        unknown_scene["kind"] = json!("image");
        unknown_scene["sceneId"] = json!("coast");
        assert!(BuiltinSceneOutput::parse(&serde_json::to_vec(&unknown_scene).unwrap()).is_err());
    }

    #[test]
    fn image_output_bounds_follow_the_design_limits() {
        let bytes = serde_json::to_vec(&request(json!({
            "kind":"image","width":1536,"height":1024,"qualityId":"high"
        })))
        .unwrap();
        WallpaperGenerateRequest::parse(&bytes).unwrap();

        for output in [
            json!({"kind":"image","width":4097,"height":1,"qualityId":"high"}),
            json!({"kind":"image","width":4096,"height":2049,"qualityId":"high"}),
            json!({"kind":"image","width":0,"height":1,"qualityId":"high"}),
        ] {
            assert!(WallpaperGenerateRequest::parse(
                &serde_json::to_vec(&request(output)).unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn artifact_validates_mime_kind_and_byte_bounds() {
        let artifact = json!({
            "artifactId":"art-0001","jobId":"job-0001","kind":"builtin",
            "sha256":SCENE_HASH_A,"bytes":1200,"mime":"application/json",
            "registryHash":SCENE_HASH_A,"generationSchemaHash":SCENE_HASH_B,
            "expiresAt":"2026-11-16T12:00:00Z"
        });
        WallpaperArtifact::parse(&serde_json::to_vec(&artifact).unwrap()).unwrap();

        let mut mismatched = artifact.clone();
        mismatched["mime"] = json!("image/png");
        assert!(WallpaperArtifact::parse(&serde_json::to_vec(&mismatched).unwrap()).is_err());

        let mut image = artifact.clone();
        image["kind"] = json!("image");
        image["mime"] = json!("image/webp");
        WallpaperArtifact::parse(&serde_json::to_vec(&image).unwrap()).unwrap();
        image["bytes"] = json!(MAX_ARTIFACT_BYTES + 1);
        assert!(WallpaperArtifact::parse(&serde_json::to_vec(&image).unwrap()).is_err());
        image["bytes"] = json!(0);
        assert!(WallpaperArtifact::parse(&serde_json::to_vec(&image).unwrap()).is_err());

        let mut bad_sha = artifact;
        bad_sha["sha256"] = json!("short");
        assert!(WallpaperArtifact::parse(&serde_json::to_vec(&bad_sha).unwrap()).is_err());
    }
}
