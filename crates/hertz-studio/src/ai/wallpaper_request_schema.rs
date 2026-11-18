// SPDX-License-Identifier: MIT
//! Registry schemas and safe output validation for the four native requests.
use hertz_wallpaper::external_requests::{Operation, Receipt};
use serde::Deserialize;
use serde_json::{json, Value};

pub(super) fn input(operation: Operation) -> Value {
    let operation_id = json!({"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9._:-]+$","description":"必需的申请幂等身份；重试同一申请时复用，内容改变时使用新身份"});
    let hex = json!({"type":"string","pattern":"^[0-9a-fA-F]{64}$"});
    let (required, properties) = match operation {
        Operation::Catalog => (
            json!([]),
            json!({"limit":{"type":"integer","minimum":1,"maximum":32,"default":32},"cursor":{"type":["integer","null"],"minimum":0,"maximum":20000}}),
        ),
        Operation::Switch => (
            json!(["operationId", "workKey", "packageHash", "targetHandle"]),
            json!({"operationId":operation_id,"workKey":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},"packageHash":hex,"targetHandle":hex}),
        ),
        Operation::Generate => (
            json!(["operationId", "brief", "outputKind"]),
            json!({"operationId":operation_id,"brief":{"type":"string","minLength":1,"maxLength":4096,"description":"最多4096 UTF-8字节；仅本机确认后进入原生成表单"},"outputKind":{"enum":["builtin","composition","image"]}}),
        ),
        Operation::Get => (
            json!(["requestId"]),
            json!({"requestId":{"type":"string","format":"uuid"}}),
        ),
    };
    json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

pub(super) fn receipt_schema() -> Value {
    json!({"type":"object","additionalProperties":false,
    "required":["requestId","operationId","state","createdAt","expiresAt"],
    "properties":{
        "requestId":{"type":"string"},"operationId":{"type":"string"},
        "state":{"enum":["pending_confirmation","accepted","succeeded","failed","rejected","cancelled","expired","interrupted"]},
        "outputKind":{"enum":["builtin","composition","image"]},"jobId":{"type":"string"},
        "nativeOperationId":{"type":"string"},"createdAt":{"type":"integer"},"expiresAt":{"type":"integer"},"errorCode":{"type":"string"}
    }})
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogWork {
    work_key: String,
    package_hash: String,
    title: String,
    tags: Vec<String>,
    kind: String,
    version: u64,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    works: Vec<CatalogWork>,
    target_handle: String,
    expires_at: i64,
    next_cursor: Option<u32>,
}

pub(super) fn catalog_schema() -> Value {
    serde_json::to_value(schemars::schema_for!(Catalog)).expect("typed catalog schema")
}

pub(super) fn valid_catalog(value: &Value) -> bool {
    serde_json::from_value::<Catalog>(value.clone()).is_ok_and(|catalog| {
        catalog.works.len() <= 32
            && hertz_wallpaper::pairing::hex64(&catalog.target_handle)
            && catalog.expires_at > 0
            && catalog.next_cursor.is_none_or(|cursor| cursor <= 20000)
            && catalog.works.iter().all(|work| {
                hertz_wallpaper::external_requests::valid_work_key(&work.work_key)
                    && hertz_wallpaper::pairing::hex64(&work.package_hash)
                    && !work.title.trim().is_empty()
                    && work.title.len() <= 1024
                    && work.tags.len() <= 32
                    && work.tags.iter().all(|tag| tag.len() <= 256)
                    && matches!(work.kind.as_str(), "builtin" | "image" | "video")
                    && work.version > 0
            })
    })
}

pub(super) fn valid_receipt(value: &Value) -> bool {
    serde_json::from_value::<Receipt>(value.clone()).is_ok_and(|receipt| {
        uuid::Uuid::parse_str(&receipt.request_id).is_ok()
            && !receipt.operation_id.is_empty()
            && receipt.operation_id.len() <= 128
            && receipt.created_at > 0
            && receipt.expires_at >= receipt.created_at
            && receipt
                .job_id
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 128)
            && receipt
                .native_operation_id
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 128)
            && receipt.error_code.as_ref().is_none_or(|code| {
                !code.is_empty()
                    && code.len() <= 128
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_' || b.is_ascii_digit())
            })
    })
}

pub(super) const CATALOG_PROJECTION: &[&str] = &[
    "works[].workKey",
    "works[].packageHash",
    "works[].title",
    "works[].tags[]",
    "works[].kind",
    "works[].version",
    "targetHandle",
    "expiresAt",
    "nextCursor",
];
pub(super) const RECEIPT_PROJECTION: &[&str] = &[
    "requestId",
    "operationId",
    "state",
    "outputKind",
    "jobId",
    "nativeOperationId",
    "createdAt",
    "expiresAt",
    "errorCode",
];
