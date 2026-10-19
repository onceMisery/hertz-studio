// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 受限能力表：门面可执行的 operation 清单与分派。
//!
//! 技术路线 §5.1 的小型能力 registry——不是插件框架，也不登记全站路由。
//! 每个条目带 operation/MCP 名、handler、输入/输出 schema、所需 scope、
//! 输出投影、效果/预算类别、能力版本与描述；
//! `tools/list`（R2-M）按会话 scope 从这里导出工具描述，而 HTTP/RPC 的
//! 官方 UI 播控不经过这里（它们直接走共享入口）。表只登记已实现的 A1
//! 能力，不提前公布未实现的工具，也不给模型一个可传任意 operation 的
//! 大入口。
//!
//! scope 模型（§5.2 A1）：每种传输播控一个独立 scope，pause-only 这类
//! 最小授权因此可表达；`playback:control` 是伞 scope，在核对时隐含六种
//! 传输播控（不含只读快照与曲库），让「全部播控」仍是一个词。
//!
//! `Handler` 分派是穷尽匹配，工具 schema 由同一条目里的输入形状生成，
//! 避免 MCP 另维护一套按字符串匹配的工具定义。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, ApiError};
use crate::idempotency::short_write;
use crate::state::{AppState, ControlOutcome};

use super::facade::GrantContext;

/// 能力协议版本：能力表与输入/输出形状的版本号。形状变更即 bump，
/// 适配器据 context 里的值判断兼容性，不做静默按当前版本解释。
pub(crate) const CAPABILITY_VERSION: &str = "1";

pub(crate) const SCOPE_PLAYBACK_PAUSE: &str = "playback:pause";
pub(crate) const SCOPE_PLAYBACK_RESUME: &str = "playback:resume";
pub(crate) const SCOPE_PLAYBACK_NEXT: &str = "playback:next";
pub(crate) const SCOPE_PLAYBACK_PREVIOUS: &str = "playback:previous";
pub(crate) const SCOPE_PLAYBACK_SEEK: &str = "playback:seek";
pub(crate) const SCOPE_PLAYBACK_VOLUME_SET: &str = "playback:volume_set";
/// 伞 scope：隐含六种传输播控（不含只读快照与曲库检索）。
pub(crate) const SCOPE_PLAYBACK_CONTROL: &str = "playback:control";
pub(crate) const SCOPE_PLAYBACK_READ: &str = "playback:read";
pub(crate) const SCOPE_LIBRARY_READ: &str = "library:read";

/// 创建 grant 时允许申请的全部 scope。scope 之外没有暗门：某个 scope
/// 没被授出，它对应的 operation 对这份凭据就不存在。
pub(crate) const STAGE_TOOLS_KEY: &str = "ai_stage_intent_tools";
pub(crate) const SCOPES: &[&str] = &[
    "stage:capabilities_read",
    "stage:intent_validate",
    SCOPE_PLAYBACK_PAUSE,
    SCOPE_PLAYBACK_RESUME,
    SCOPE_PLAYBACK_NEXT,
    SCOPE_PLAYBACK_PREVIOUS,
    SCOPE_PLAYBACK_SEEK,
    SCOPE_PLAYBACK_VOLUME_SET,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_PLAYBACK_READ,
    SCOPE_LIBRARY_READ,
];

/// scope 核对：直接命中，或由伞 scope 隐含（`playback:control` ⇒ 六种
/// 传输播控；只读快照与曲库检索不在伞内）。
pub(crate) fn scope_satisfied(granted: &BTreeSet<String>, required: &str) -> bool {
    if granted.contains(required) {
        return true;
    }
    required.starts_with("playback:")
        && required != SCOPE_PLAYBACK_READ
        && granted.contains(SCOPE_PLAYBACK_CONTROL)
}

/// 只读能力不占用去重表，也不产生播放副作用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    ReadOnly,
    Mutating,
}

impl Effect {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Effect::ReadOnly => "read_only",
            Effect::Mutating => "mutating",
        }
    }
}

/// 注册表里的一条能力。`operation` 是门面内部名（点分），`mcp_name` 是
/// MCP 工具名（下划线，与路线图 §5.2 的 A1 工具表一致）；两者都可作为
/// [`find`] 的键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Handler {
    StageCapabilitiesGet,
    StageIntentValidate,
    PlaybackSnapshotGet,
    PlaybackPause,
    PlaybackResume,
    PlaybackNext,
    PlaybackPrevious,
    PlaybackSeek,
    PlaybackVolumeSet,
    LibrarySearch,
}

impl Handler {
    pub(crate) fn operation(self) -> &'static str {
        match self {
            Self::StageCapabilitiesGet => "stage.capabilities_get",
            Self::StageIntentValidate => "stage.intent_validate",
            Self::PlaybackSnapshotGet => "playback.snapshot_get",
            Self::PlaybackPause => "playback.pause",
            Self::PlaybackResume => "playback.resume",
            Self::PlaybackNext => "playback.next",
            Self::PlaybackPrevious => "playback.previous",
            Self::PlaybackSeek => "playback.seek",
            Self::PlaybackVolumeSet => "playback.volume_set",
            Self::LibrarySearch => "library_search",
        }
    }

    pub(crate) fn is_stage(self) -> bool {
        matches!(self, Self::StageCapabilitiesGet | Self::StageIntentValidate)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputSchema {
    Empty,
    StagePage,
    StageArtifact,
    Seek,
    Volume,
    LibrarySearch,
}

impl InputSchema {
    pub(crate) fn value(self) -> Value {
        match self {
            Self::Empty => json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
            Self::StagePage => json!({ "type": "object", "additionalProperties": false,
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 10 },
                    "offset": { "type": "integer", "minimum": 0, "maximum": 10000 } } }),
            Self::StageArtifact => json!({ "type": "object", "additionalProperties": false,
                "required": ["artifactVersion", "mode", "intent", "schemaVersion", "schemaHash", "basePresetHash"],
                "properties": { "artifactVersion": { "const": 1 }, "mode": { "const": "create" },
                    "intent": { "type": "object" }, "schemaVersion": { "type": "string" },
                    "schemaHash": { "type": "string" }, "basePresetHash": { "type": "string" } } }),
            Self::Seek => json!({
                "type": "object",
                "properties": { "positionMs": { "type": "integer", "minimum": 0 } },
                "required": ["positionMs"],
                "additionalProperties": false,
            }),
            Self::Volume => json!({
                "type": "object",
                "properties": { "value": { "type": "number", "minimum": 0, "maximum": 1 } },
                "required": ["value"],
                "additionalProperties": false,
            }),
            Self::LibrarySearch => json!({ "type": "object", "additionalProperties": false,
                "required": ["q"], "properties": { "q": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                    "offset": { "type": "integer", "minimum": 0, "maximum": 10000 } } }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputSchema {
    StagePage,
    StageValidation,
    PlaybackSnapshot,
    ControlOutcome,
    LibrarySearch,
}

impl OutputSchema {
    pub(crate) fn value(self) -> Value {
        match self {
            Self::StagePage => json!({
                "type": "object", "additionalProperties": false,
                "required": ["artifactVersion", "mode", "schemaVersion", "schemaHash", "basePresetHashes", "commonParams", "scenes", "total", "offset", "nextOffset", "intentFields", "limits", "persisted", "applied"],
                "properties": {
                    "artifactVersion": { "const": 1 }, "mode": { "const": "create" },
                    "schemaVersion": { "type": "string" }, "schemaHash": { "type": "string" },
                    "basePresetHashes": { "type": "object", "additionalProperties": { "type": "string" } },
                    "commonParams": { "type": "array", "items": { "$ref": "#/$defs/sceneParam" } },
                    "scenes": { "type": "array", "items": { "$ref": "#/$defs/scene" } },
                    "total": { "type": "integer", "minimum": 0 }, "offset": { "type": "integer", "minimum": 0 },
                    "nextOffset": { "type": ["integer", "null"], "minimum": 0 },
                    "intentFields": { "type": "array", "items": { "type": "string" } },
                    "limits": { "type": "object", "required": ["maxBytes", "maxDepth"], "properties": {
                        "maxBytes": { "type": "integer", "const": 16384 }, "maxDepth": { "type": "integer", "const": 8 }
                    }, "additionalProperties": false },
                    "persisted": { "const": false }, "applied": { "const": false }
                },
                "$defs": {
                    "sceneParam": { "type": "object", "required": ["name", "min", "max", "default"], "properties": {
                        "name": { "type": "string" }, "min": { "type": ["number", "null"] },
                        "max": { "type": ["number", "null"] }, "default": {}
                    }, "additionalProperties": false },
                    "scene": { "type": "object", "required": ["id", "label", "aliases", "ownsLyrics", "params"], "properties": {
                        "id": { "type": "string" }, "label": { "type": "string" },
                        "aliases": { "type": "array", "items": { "type": "string" } },
                        "ownsLyrics": { "type": "boolean" },
                        "params": { "type": "array", "items": { "$ref": "#/$defs/sceneParam" } }
                    }, "additionalProperties": false }
                }
            }),
            Self::StageValidation => json!({
                "type": "object", "additionalProperties": false,
                "required": ["validationStage", "validatedIntent", "schemaVersion", "schemaHash", "basePresetHash", "artifact", "diagnostics", "persisted", "applied"],
                "properties": {
                    "validationStage": { "const": "intent" }, "validatedIntent": { "$ref": "#/$defs/intent" },
                    "schemaVersion": { "type": "string" }, "schemaHash": { "type": "string" },
                    "basePresetHash": { "type": "string" }, "artifact": { "$ref": "#/$defs/artifact" },
                    "diagnostics": { "const": [] }, "persisted": { "const": false }, "applied": { "const": false }
                },
                "$defs": {
                    "intent": { "type": "object", "required": ["version", "scene", "patch"], "properties": {
                        "version": { "const": 1 }, "scene": { "type": "string" },
                        "patch": { "type": "object", "additionalProperties": { "type": "number" } },
                        "director": { "type": "boolean" }, "hand": { "type": "object", "required": ["on"],
                            "properties": { "on": { "type": "boolean" } }, "additionalProperties": false },
                        "ruleIds": { "type": "array", "items": { "type": "string" } }
                    }, "additionalProperties": false },
                    "artifact": { "type": "object", "required": ["artifactVersion", "mode", "intent", "schemaVersion", "schemaHash", "basePresetHash"], "properties": {
                        "artifactVersion": { "const": 1 }, "mode": { "const": "create" },
                        "intent": { "$ref": "#/$defs/intent" }, "schemaVersion": { "type": "string" },
                        "schemaHash": { "type": "string" }, "basePresetHash": { "type": "string" }
                    }, "additionalProperties": false }
                }
            }),
            Self::PlaybackSnapshot => json!({
                "type": "object", "additionalProperties": false,
                "required": ["outcome", "code", "data"],
                "properties": {
                    "outcome": { "const": "ok" }, "code": { "const": "ok" },
                    "data": { "type": "object", "additionalProperties": false,
                        "required": ["trackId", "positionMs", "durationMs", "playing", "volume", "mode", "generation", "queueLength", "queueIndex"],
                        "properties": {
                            "trackId": { "type": ["string", "null"] }, "positionMs": { "type": "integer", "minimum": 0 },
                            "durationMs": { "type": ["integer", "null"], "minimum": 0 }, "playing": { "type": "boolean" },
                            "volume": { "type": "number", "minimum": 0, "maximum": 1 },
                            "mode": { "enum": ["repeat", "repeat_one", "shuffle"] },
                            "generation": { "type": "integer", "minimum": 0 }, "queueLength": { "type": "integer", "minimum": 0 },
                            "queueIndex": { "type": ["integer", "null"], "minimum": 0 }
                        }
                    }
                }
            }),
            Self::ControlOutcome => json!({
                "type": "object", "additionalProperties": false,
                "required": ["outcome", "code", "generation"],
                "properties": {
                    "outcome": { "enum": ["applied", "no_op", "superseded"] },
                    "code": { "type": "string" }, "generation": { "type": ["integer", "null"], "minimum": 0 }
                }
            }),
            Self::LibrarySearch => json!({
                "type": "object", "additionalProperties": false,
                "required": ["outcome", "code", "data"],
                "properties": {
                    "outcome": { "const": "ok" }, "code": { "const": "ok" },
                    "data": { "type": "object", "additionalProperties": false, "required": ["tracks"],
                        "properties": { "tracks": { "type": "array", "items": { "type": "object", "additionalProperties": false,
                            "required": ["id", "title", "artist", "album", "durationMs", "source"],
                            "properties": {
                                "id": { "type": "string" }, "title": { "type": "string" },
                                "artist": { "type": ["string", "null"] }, "album": { "type": ["string", "null"] },
                                "durationMs": { "type": ["integer", "null"], "minimum": 0 },
                                "source": { "enum": ["local", "remote"] }
                            }
                        } } }
                    }
                }
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum RegisteredControlOutcome {
    Applied,
    NoOp,
    Superseded,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum RegisteredPlaybackMode {
    Repeat,
    RepeatOne,
    Shuffle,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum RegisteredTrackSource {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
enum RegisteredCreateMode {
    #[serde(rename = "create")]
    Create,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
enum RegisteredIntentValidationStage {
    #[serde(rename = "intent")]
    Intent,
}

#[derive(Debug, serde::Deserialize)]
#[serde(transparent)]
struct RequiredNullable<T>(Option<T>);

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredParam {
    name: String,
    min: RequiredNullable<f64>,
    max: RequiredNullable<f64>,
    default: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredScene {
    id: String,
    label: String,
    aliases: Vec<String>,
    owns_lyrics: bool,
    params: Vec<RegisteredParam>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisteredLimits {
    max_bytes: usize,
    max_depth: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredStagePage {
    artifact_version: u32,
    mode: RegisteredCreateMode,
    schema_version: String,
    schema_hash: String,
    base_preset_hashes: BTreeMap<String, String>,
    common_params: Vec<RegisteredParam>,
    scenes: Vec<RegisteredScene>,
    total: usize,
    offset: usize,
    next_offset: RequiredNullable<usize>,
    intent_fields: Vec<String>,
    limits: RegisteredLimits,
    persisted: bool,
    applied: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredHand {
    on: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredStageIntent {
    version: u32,
    scene: String,
    patch: BTreeMap<String, f64>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    director: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    hand: Option<RegisteredHand>,
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    rule_ids: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredArtifact {
    artifact_version: u32,
    mode: RegisteredCreateMode,
    intent: RegisteredStageIntent,
    schema_version: String,
    schema_hash: String,
    base_preset_hash: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredStageValidation {
    validation_stage: RegisteredIntentValidationStage,
    validated_intent: RegisteredStageIntent,
    schema_version: String,
    schema_hash: String,
    base_preset_hash: String,
    artifact: RegisteredArtifact,
    diagnostics: Vec<Value>,
    persisted: bool,
    applied: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredPlaybackData {
    track_id: RequiredNullable<String>,
    position_ms: u64,
    duration_ms: RequiredNullable<u64>,
    playing: bool,
    volume: f64,
    mode: RegisteredPlaybackMode,
    generation: u64,
    queue_length: usize,
    queue_index: RequiredNullable<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
enum RegisteredOk {
    #[serde(rename = "ok")]
    Ok,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisteredPlaybackSnapshot {
    outcome: RegisteredOk,
    code: RegisteredOk,
    data: RegisteredPlaybackData,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredControlResult {
    outcome: RegisteredControlOutcome,
    code: String,
    generation: RequiredNullable<u64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredTrack {
    id: String,
    title: String,
    artist: RequiredNullable<String>,
    album: RequiredNullable<String>,
    duration_ms: RequiredNullable<u64>,
    source: RegisteredTrackSource,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredLibraryData {
    tracks: Vec<RegisteredTrack>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct RegisteredLibrarySearch {
    outcome: RegisteredOk,
    code: RegisteredOk,
    data: RegisteredLibraryData,
}

fn validate_registered_output(schema: OutputSchema, value: &Value) -> bool {
    match schema {
        OutputSchema::StagePage => serde_json::from_value::<RegisteredStagePage>(value.clone())
            .is_ok_and(|page| {
                page.artifact_version == 1
                    && page.limits.max_bytes == 16_384
                    && page.limits.max_depth == 8
                    && !page.persisted
                    && !page.applied
            }),
        OutputSchema::StageValidation => {
            serde_json::from_value::<RegisteredStageValidation>(value.clone()).is_ok_and(|result| {
                result.diagnostics.is_empty()
                    && !result.persisted
                    && !result.applied
                    && result.artifact.artifact_version == 1
                    && result.validated_intent.version == 1
                    && result.artifact.intent.version == 1
            })
        }
        OutputSchema::PlaybackSnapshot => serde_json::from_value::<RegisteredPlaybackSnapshot>(
            value.clone(),
        )
        .is_ok_and(|snapshot| {
            snapshot.data.volume.is_finite()
                && (0.0..=1.0).contains(&snapshot.data.volume)
                && snapshot.outcome == RegisteredOk::Ok
                && snapshot.code == RegisteredOk::Ok
        }),
        OutputSchema::ControlOutcome => {
            serde_json::from_value::<RegisteredControlResult>(value.clone()).is_ok()
        }
        OutputSchema::LibrarySearch => {
            serde_json::from_value::<RegisteredLibrarySearch>(value.clone()).is_ok()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BudgetClass {
    /// This capability does not dispatch an AI provider request.
    NoProviderCall,
}

impl BudgetClass {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NoProviderCall => "no_provider_call",
        }
    }
}

pub(crate) struct Capability {
    pub mcp_name: &'static str,
    pub handler: Handler,
    pub input_schema: InputSchema,
    pub output_schema: OutputSchema,
    pub scope: &'static str,
    pub allowed_projection: &'static [&'static str],
    pub effect: Effect,
    pub budget_class: BudgetClass,
    pub version: &'static str,
    pub description: &'static str,
}

pub(crate) const CAPABILITIES: &[Capability] = &[
    Capability {
        mcp_name: "stage_capabilities_get",
        handler: Handler::StageCapabilitiesGet,
        input_schema: InputSchema::StagePage,
        output_schema: OutputSchema::StagePage,
        scope: "stage:capabilities_read",
        allowed_projection: &[
            "artifactVersion",
            "mode",
            "schemaVersion",
            "schemaHash",
            "basePresetHashes.*",
            "commonParams[].name",
            "commonParams[].min",
            "commonParams[].max",
            "commonParams[].default",
            "scenes[].id",
            "scenes[].label",
            "scenes[].aliases[]",
            "scenes[].ownsLyrics",
            "scenes[].params[].name",
            "scenes[].params[].min",
            "scenes[].params[].max",
            "scenes[].params[].default",
            "total",
            "offset",
            "nextOffset",
            "intentFields[]",
            "limits.maxBytes",
            "limits.maxDepth",
            "persisted",
            "applied",
        ],
        effect: Effect::ReadOnly,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "分页查询舞台场景、参数与草稿版本；不读取活动舞台",
    },
    Capability {
        mcp_name: "stage_intent_validate",
        handler: Handler::StageIntentValidate,
        input_schema: InputSchema::StageArtifact,
        output_schema: OutputSchema::StageValidation,
        scope: "stage:intent_validate",
        allowed_projection: &[
            "validationStage",
            "validatedIntent.version",
            "validatedIntent.scene",
            "validatedIntent.patch",
            "validatedIntent.patch.*",
            "validatedIntent.director",
            "validatedIntent.hand.on",
            "validatedIntent.ruleIds",
            "validatedIntent.ruleIds[]",
            "schemaVersion",
            "schemaHash",
            "basePresetHash",
            "artifact.artifactVersion",
            "artifact.mode",
            "artifact.intent.version",
            "artifact.intent.scene",
            "artifact.intent.patch",
            "artifact.intent.patch.*",
            "artifact.intent.director",
            "artifact.intent.hand.on",
            "artifact.intent.ruleIds",
            "artifact.intent.ruleIds[]",
            "artifact.schemaVersion",
            "artifact.schemaHash",
            "artifact.basePresetHash",
            "diagnostics",
            "diagnostics[]",
            "persisted",
            "applied",
        ],
        effect: Effect::ReadOnly,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "校验显式 create 草稿信封；仅 intent 校验，不调用模型、不物化、不应用",
    },
    Capability {
        mcp_name: "playback_snapshot_get",
        handler: Handler::PlaybackSnapshotGet,
        input_schema: InputSchema::Empty,
        output_schema: OutputSchema::PlaybackSnapshot,
        scope: SCOPE_PLAYBACK_READ,
        allowed_projection: &[
            "outcome",
            "code",
            "data.trackId",
            "data.positionMs",
            "data.durationMs",
            "data.playing",
            "data.volume",
            "data.mode",
            "data.generation",
            "data.queueLength",
            "data.queueIndex",
        ],
        effect: Effect::ReadOnly,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "最小播放快照；标题/歌手等元数据不在内",
    },
    Capability {
        mcp_name: "playback_pause",
        handler: Handler::PlaybackPause,
        input_schema: InputSchema::Empty,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_PAUSE,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "暂停当前播放",
    },
    Capability {
        mcp_name: "playback_resume",
        handler: Handler::PlaybackResume,
        input_schema: InputSchema::Empty,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_RESUME,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "恢复当前已装载曲目；未装载时明确拒绝",
    },
    Capability {
        mcp_name: "playback_next",
        handler: Handler::PlaybackNext,
        input_schema: InputSchema::Empty,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_NEXT,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "下一曲；完成事实含 applied/no_op/superseded",
    },
    Capability {
        mcp_name: "playback_previous",
        handler: Handler::PlaybackPrevious,
        input_schema: InputSchema::Empty,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_PREVIOUS,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "上一曲",
    },
    Capability {
        mcp_name: "playback_seek",
        handler: Handler::PlaybackSeek,
        input_schema: InputSchema::Seek,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_SEEK,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "定位当前曲目，入参 positionMs",
    },
    Capability {
        mcp_name: "playback_volume_set",
        handler: Handler::PlaybackVolumeSet,
        input_schema: InputSchema::Volume,
        output_schema: OutputSchema::ControlOutcome,
        scope: SCOPE_PLAYBACK_VOLUME_SET,
        allowed_projection: &["outcome", "code", "generation"],
        effect: Effect::Mutating,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description: "设置音量，入参 value 取 0.0–1.0",
    },
    Capability {
        mcp_name: "library_search",
        handler: Handler::LibrarySearch,
        input_schema: InputSchema::LibrarySearch,
        output_schema: OutputSchema::LibrarySearch,
        scope: SCOPE_LIBRARY_READ,
        allowed_projection: &[
            "outcome",
            "code",
            "data.tracks[].id",
            "data.tracks[].title",
            "data.tracks[].artist",
            "data.tracks[].album",
            "data.tracks[].durationMs",
            "data.tracks[].source",
        ],
        effect: Effect::ReadOnly,
        budget_class: BudgetClass::NoProviderCall,
        version: CAPABILITY_VERSION,
        description:
            "检索已授权的本地/已导入曲库索引；limit 默认 20（1–50），offset 0–10000；不返回文件路径",
    },
];

/// 按内部名或 MCP 工具名查能力。
pub(crate) fn find(operation: &str) -> Option<&'static Capability> {
    CAPABILITIES
        .iter()
        .find(|c| c.handler.operation() == operation || c.mcp_name == operation)
}

/// 一次受限调用的入参。
pub(crate) struct CapabilityCall {
    pub operation: String,
    pub client_operation_id: Option<String>,
    pub input: Value,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeekInput {
    position_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VolumeInput {
    value: f32,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LibrarySearchInput {
    q: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct StagePageInput {
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) async fn stage_tools_enabled(state: &AppState) -> Result<bool, ApiError> {
    vmusic_store::settings::get(&state.db, STAGE_TOOLS_KEY)
        .await
        .map(|v| v.and_then(|v| v.as_bool()).unwrap_or(false))
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))
}

/// 执行一次受限能力调用。scope 在查表之后、执行之前核对；变更命令统一走
/// [`short_write`]，principal 绑定 grantId——与官方 UI 的 local-owner 互不
/// 串键，完成事实就是共享入口给出的那一份，不在这里二次粉饰。
pub(crate) async fn execute(
    state: &Arc<AppState>,
    ctx: &GrantContext,
    call: CapabilityCall,
) -> Result<Value, ApiError> {
    let capability = find(&call.operation).ok_or_else(|| {
        ApiError::capability_unsupported(format!("未登记的能力: {}", call.operation))
    })?;
    if !scope_satisfied(&ctx.scopes, capability.scope) {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "scope_required",
            format!("该凭据缺少 scope: {}", capability.scope),
        ));
    }
    if capability.handler.is_stage() && !stage_tools_enabled(state).await? {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "stage_tools_disabled",
            "舞台契约工具尚未开启",
        ));
    }
    let result = match capability.handler {
        Handler::StageCapabilitiesGet => {
            let input: StagePageInput = if call.input.is_null() {
                StagePageInput::default()
            } else {
                parse_input(&call.input)?
            };
            let limit = input.limit.unwrap_or(5);
            if !(1..=10).contains(&limit) || input.offset > 10_000 {
                return Err(bad_request("limit 必须为 1–10，offset 必须为 0–10000"));
            }
            Ok(super::contract::page(input.offset, limit))
        }
        Handler::StageIntentValidate => {
            super::contract::validate_artifact(&call.input).map_err(|message| {
                ApiError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    "stage_artifact_invalid",
                    message,
                )
            })
        }
        Handler::PlaybackSnapshotGet => {
            require_no_input(&call.input)?;
            Ok(snapshot(state).await)
        }
        Handler::PlaybackPause => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                Value::Null,
                |s| async move { s.pause_control().await },
            )
            .await
        }
        Handler::PlaybackResume => {
            require_no_input(&call.input)?;
            // 受限门面的 resume 是严格语义（§5.2）：未装载明确拒绝，
            // 绝不走官方 UI 的会话恢复分支。
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                Value::Null,
                |s| async move { s.resume_control(true).await },
            )
            .await
        }
        Handler::PlaybackNext => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                Value::Null,
                |s| async move { s.step_by_user(1).await },
            )
            .await
        }
        Handler::PlaybackPrevious => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                Value::Null,
                |s| async move { s.step_by_user(-1).await },
            )
            .await
        }
        Handler::PlaybackSeek => {
            let input: SeekInput = parse_input(&call.input)?;
            let position_ms = input.position_ms;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                json!(position_ms),
                move |s| async move { s.seek_control(position_ms).await },
            )
            .await
        }
        Handler::PlaybackVolumeSet => {
            let input: VolumeInput = parse_input(&call.input)?;
            let value = input.value;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                capability.handler.operation(),
                json!(value),
                move |s| async move { s.set_volume_control(value).await },
            )
            .await
        }
        Handler::LibrarySearch => {
            // 本地索引查询不走在线搜索闸（§4.1 的闸管的是上游音源调用）。
            // 投影白名单：不返回文件路径；凭据类字段本就不在曲库表里。
            let input: LibrarySearchInput = parse_input(&call.input)?;
            let (limit, offset) = library_search_page(input.limit, input.offset)?;
            let tracks = vmusic_store::list_tracks(&state.db, Some(&input.q), limit, offset)
                .await
                .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
            let tracks: Vec<Value> = tracks
                .iter()
                .map(|t| {
                    json!({
                        "id": t.id,
                        "title": t.title,
                        "artist": t.artist,
                        "album": t.album,
                        "durationMs": t.duration_ms,
                        "source": t.source,
                    })
                })
                .collect();
            Ok(json!({
                "outcome": "ok",
                "code": "ok",
                "data": { "tracks": tracks },
            }))
        }
    }?;
    if !validate_registered_output(capability.output_schema, &result) {
        return Err(crate::error::internal(format!(
            "{} returned a response outside its registered output schema",
            capability.handler.operation()
        )));
    }
    ensure_allowed_projection(capability, &result)?;
    Ok(result)
}

fn ensure_allowed_projection(capability: &Capability, value: &Value) -> Result<(), ApiError> {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum PathPart {
        Field(String),
        ArrayItem,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum PatternPart<'a> {
        Field(&'a str),
        AnyField,
        ArrayItem,
    }

    fn pattern_parts(pattern: &str) -> Vec<PatternPart<'_>> {
        let mut parts = Vec::new();
        for part in pattern.split('.') {
            if part == "*" {
                parts.push(PatternPart::AnyField);
            } else if let Some(field) = part.strip_suffix("[]") {
                parts.push(PatternPart::Field(field));
                parts.push(PatternPart::ArrayItem);
            } else {
                parts.push(PatternPart::Field(part));
            }
        }
        parts
    }

    fn prefix_matches(path: &[PathPart], pattern: &[PatternPart<'_>]) -> bool {
        if path.len() > pattern.len() {
            return false;
        }
        for (path_part, pattern_part) in path.iter().zip(pattern) {
            let matched = match (path_part, pattern_part) {
                (PathPart::Field(value), PatternPart::Field(expected)) => value == expected,
                (PathPart::Field(_), PatternPart::AnyField) => true,
                (PathPart::ArrayItem, PatternPart::ArrayItem) => true,
                _ => false,
            };
            if !matched {
                return false;
            }
        }
        true
    }

    fn matches(path: &[PathPart], pattern: &str) -> bool {
        let pattern = pattern_parts(pattern);
        path.len() == pattern.len() && prefix_matches(path, &pattern)
    }

    fn visit(
        value: &Value,
        path: &mut Vec<PathPart>,
        paths: &mut Vec<Vec<PathPart>>,
        allowed: &[&str],
    ) {
        let is_atomic_field = allowed.iter().any(|pattern| {
            !pattern.contains('*')
                && matches(path, pattern)
                && !allowed.iter().any(|candidate| {
                    let candidate_parts = pattern_parts(candidate);
                    candidate_parts.len() > path.len() && prefix_matches(path, &candidate_parts)
                })
        });
        if is_atomic_field && (value.is_object() || value.is_array()) {
            paths.push(path.clone());
            return;
        }

        match value {
            Value::Object(map) if map.is_empty() => {}
            Value::Object(map) => {
                for (key, child) in map {
                    path.push(PathPart::Field(key.clone()));
                    visit(child, path, paths, allowed);
                    path.pop();
                }
            }
            Value::Array(items) if items.is_empty() => {}
            Value::Array(items) => {
                for child in items {
                    path.push(PathPart::ArrayItem);
                    visit(child, path, paths, allowed);
                    path.pop();
                }
            }
            _ => paths.push(path.clone()),
        }
    }

    let mut paths = Vec::new();
    visit(
        value,
        &mut Vec::new(),
        &mut paths,
        capability.allowed_projection,
    );
    if paths.iter().any(|path| {
        !capability
            .allowed_projection
            .iter()
            .any(|pattern| matches(path, pattern))
    }) {
        return Err(crate::error::internal(format!(
            "{} returned a field outside its registered projection",
            capability.handler.operation()
        )));
    }
    Ok(())
}

/// 变更能力的公共路径：无参命令的 input 已由调用方核对，这里统一进
/// 幂等入口并折叠成类型化应答。
async fn mutate<F, Fut>(
    state: &Arc<AppState>,
    ctx: &GrantContext,
    client_operation_id: Option<&str>,
    op: &'static str,
    input: Value,
    exec: F,
) -> Result<Value, ApiError>
where
    F: FnOnce(Arc<AppState>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<ControlOutcome, vmusic_core::CoreError>>
        + Send
        + 'static,
{
    // 幂等输入必须携带真实参数：同键不同参数是冲突，不是回放——
    // 统一塞 Null 会让「同键把音量从 0.2 改成 0.8」静默变成第二次执行。
    let outcome = short_write(
        state.clone(),
        &ctx.grant_id,
        op,
        client_operation_id,
        input,
        exec,
    )
    .await
    .map_err(ApiError::from)?;
    Ok(outcome_json(&outcome))
}

/// 统一结果形状（§5.6）：outcome 是粗事实，code 是稳定机器码，generation
/// 只在事实携带它时出现。快照只提供随后观察，不属于这里。
fn outcome_json(outcome: &ControlOutcome) -> Value {
    match outcome {
        ControlOutcome::Applied { generation } => {
            json!({ "outcome": "applied", "code": "applied", "generation": generation })
        }
        ControlOutcome::NoOp { code } => {
            json!({ "outcome": "no_op", "code": code.as_str(), "generation": Value::Null })
        }
        ControlOutcome::Superseded { generation } => {
            json!({ "outcome": "superseded", "code": "superseded", "generation": generation })
        }
    }
}

/// 最小播放快照（§5.2 A1）：投影白名单里的字段。标题/歌手等元数据需要
/// trackMetadata 类 scope，本轮未登记——连错误响应也不得透露曲名。
async fn snapshot(state: &Arc<AppState>) -> Value {
    let snap = state.audio.snapshot();
    json!({
        "outcome": "ok",
        "code": "ok",
        "data": {
            "trackId": snap.track_id,
            "positionMs": snap.position_ms,
            "durationMs": snap.duration_ms,
            "playing": snap.playing,
            "volume": snap.volume,
            "mode": snap.mode,
            "generation": snap.generation,
            "queueLength": state.queue.lock().await.len(),
            "queueIndex": state.current_index().await,
        }
    })
}

/// 无参能力的输入闸：Null 或空对象之外一律拒绝——未知字段不允许从
/// 受控入口溜进去（§8.1）。
fn require_no_input(input: &Value) -> Result<(), ApiError> {
    match input {
        Value::Null => Ok(()),
        Value::Object(map) if map.is_empty() => Ok(()),
        _ => Err(bad_request("该能力不接受输入参数")),
    }
}

fn parse_input<T: serde::de::DeserializeOwned>(input: &Value) -> Result<T, ApiError> {
    serde_json::from_value(input.clone()).map_err(|e| bad_request(format!("能力入参不合法: {e}")))
}

fn library_search_page(limit: Option<i64>, offset: Option<i64>) -> Result<(i64, i64), ApiError> {
    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);
    if !(1..=50).contains(&limit) || !(0..=10_000).contains(&offset) {
        return Err(bad_request(
            "limit 必须为 1-50，offset 必须为 0-10000",
        ));
    }
    Ok((limit, offset))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_allowed_projection, find, library_search_page, outcome_json,
        validate_registered_output, ControlOutcome, CAPABILITIES,
    };
    use serde_json::json;

    #[test]
    fn library_search_page_matches_advertised_bounds() {
        assert_eq!(library_search_page(None, None).unwrap(), (20, 0));
        assert_eq!(library_search_page(Some(1), Some(0)).unwrap(), (1, 0));
        assert_eq!(library_search_page(Some(50), Some(10_000)).unwrap(), (50, 10_000));

        for (limit, offset) in [
            (Some(0), Some(0)),
            (Some(51), Some(0)),
            (Some(20), Some(-1)),
            (Some(20), Some(10_001)),
        ] {
            assert!(library_search_page(limit, offset).is_err());
        }
    }

    #[test]
    fn registered_output_projections_match_domain_results_and_reject_extra_fields() {
        let page = crate::ai::contract::page(0, 10);
        let page_capability = find("stage_capabilities_get").unwrap();
        assert!(validate_registered_output(
            page_capability.output_schema,
            &page
        ));
        ensure_allowed_projection(page_capability, &page).unwrap();
        let empty_page = crate::ai::contract::page(10_000, 10);
        assert!(validate_registered_output(
            page_capability.output_schema,
            &empty_page
        ));
        ensure_allowed_projection(page_capability, &empty_page).unwrap();
        let mut structured_default_page = page.clone();
        structured_default_page["commonParams"][0]["default"] = json!({ "curve": [0.2, 0.5] });
        assert!(validate_registered_output(
            page_capability.output_schema,
            &structured_default_page
        ));
        ensure_allowed_projection(page_capability, &structured_default_page).unwrap();
        let mut malformed_page = page.clone();
        malformed_page["total"] = json!("not a number");
        assert!(!validate_registered_output(
            page_capability.output_schema,
            &malformed_page
        ));
        malformed_page = page.clone();
        malformed_page.as_object_mut().unwrap().remove("total");
        assert!(!validate_registered_output(
            page_capability.output_schema,
            &malformed_page
        ));
        malformed_page = page.clone();
        malformed_page["unexpected"] = json!({});
        assert!(!validate_registered_output(
            page_capability.output_schema,
            &malformed_page
        ));

        let scene = &crate::ai::contract::scenes()[0];
        let intent = json!({
            "version": 1,
            "scene": scene.id,
            "patch": { format!("sc.{}", scene.params[0].name): 0.5 },
            "director": true,
            "hand": { "on": false },
            "ruleIds": ["fixture-rule"]
        });
        let artifact = crate::ai::contract::artifact(&intent);
        let validated = crate::ai::contract::validate_artifact(&artifact).unwrap();
        let validation_capability = find("stage_intent_validate").unwrap();
        assert!(validate_registered_output(
            validation_capability.output_schema,
            &validated
        ));
        ensure_allowed_projection(validation_capability, &validated).unwrap();
        let mut nested_dynamic_field = validated.clone();
        nested_dynamic_field["validatedIntent"]["patch"]["look"] = json!({ "nested": 0.5 });
        assert!(ensure_allowed_projection(validation_capability, &nested_dynamic_field).is_err());
        let mut null_optional_field = validated.clone();
        null_optional_field["validatedIntent"]["director"] = serde_json::Value::Null;
        assert!(!validate_registered_output(
            validation_capability.output_schema,
            &null_optional_field
        ));

        for outcome in [
            ControlOutcome::Applied { generation: 2 },
            ControlOutcome::NoOp {
                code: crate::state::NoOpCode::EmptyQueue,
            },
            ControlOutcome::Superseded { generation: 3 },
        ] {
            let control_capability = find("playback_pause").unwrap();
            let output = outcome_json(&outcome);
            assert!(validate_registered_output(
                control_capability.output_schema,
                &output
            ));
            ensure_allowed_projection(control_capability, &output).unwrap();
        }

        let snapshot = json!({
            "outcome": "ok", "code": "ok", "data": {
                "trackId": null, "positionMs": 0, "durationMs": null, "playing": false,
                "volume": 0.8, "mode": "repeat", "generation": 0,
                "queueLength": 0, "queueIndex": null
            }
        });
        let snapshot_capability = find("playback_snapshot_get").unwrap();
        assert!(validate_registered_output(
            snapshot_capability.output_schema,
            &snapshot
        ));
        ensure_allowed_projection(snapshot_capability, &snapshot).unwrap();

        let search = json!({ "outcome": "ok", "code": "ok", "data": { "tracks": [{
            "id": "fixture", "title": "Fixture", "artist": null, "album": null,
            "durationMs": null, "source": "local"
        }] } });
        let search_capability = find("library_search").unwrap();
        assert!(validate_registered_output(
            search_capability.output_schema,
            &search
        ));
        ensure_allowed_projection(search_capability, &search).unwrap();
        let empty_search = json!({ "outcome": "ok", "code": "ok", "data": { "tracks": [] } });
        assert!(validate_registered_output(
            search_capability.output_schema,
            &empty_search
        ));
        ensure_allowed_projection(search_capability, &empty_search).unwrap();
        let missing_search = json!({ "outcome": "ok", "code": "ok", "data": {} });
        assert!(!validate_registered_output(
            search_capability.output_schema,
            &missing_search
        ));
        let mut leaked = search;
        leaked["data"]["tracks"][0]["path"] = json!("private/path.flac");
        assert!(!validate_registered_output(
            search_capability.output_schema,
            &leaked
        ));
        assert!(ensure_allowed_projection(search_capability, &leaked).is_err());

        assert_eq!(CAPABILITIES.len(), 10);
        assert!(
            CAPABILITIES
                .iter()
                .all(|capability| capability.output_schema.value().is_object()
                    && !capability.allowed_projection.is_empty()
                    && capability.version == super::CAPABILITY_VERSION)
        );
    }
}
