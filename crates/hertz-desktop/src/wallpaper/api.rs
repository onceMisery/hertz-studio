// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! §14 的正式壁纸命令信封，复用现有管理管道与可信设置页入口。

use super::jobs::JobError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub protocol: u32,
    pub request_id: String,
    pub command: String,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub(crate) enum Command {
    DraftCreate,
    DraftUpdate {
        draft_id: String,
        draft_revision: u64,
        operations: Vec<super::settings_drafts::Update>,
    },
    DraftDiscard {
        draft_id: String,
        draft_revision: u64,
    },
    Apply {
        draft_id: String,
        draft_revision: u64,
    },
    PreviewAcquire {
        draft_id: String,
        draft_revision: u64,
    },
    PreviewUpdate {
        lease_id: String,
        draft_id: String,
        draft_revision: u64,
    },
    PreviewRenew {
        lease_id: String,
    },
    PreviewRelease {
        lease_id: String,
    },
    Capabilities,
    Status,
    LibraryList {
        limit: u32,
        cursor: Option<String>,
    },
    LibraryGet {
        work_key: String,
    },
    FilePick,
    ImportBegin {
        file_token: String,
    },
    JobsGet {
        job_id: String,
    },
    JobsCancel {
        job_id: String,
    },
    OperationsGet {
        request_id: String,
        command: Option<String>,
    },
}

impl Command {
    pub(crate) fn settings_command(&self) -> bool {
        matches!(
            self,
            Self::DraftCreate
                | Self::DraftUpdate { .. }
                | Self::DraftDiscard { .. }
                | Self::Apply { .. }
                | Self::PreviewAcquire { .. }
                | Self::PreviewUpdate { .. }
                | Self::PreviewRenew { .. }
                | Self::PreviewRelease { .. }
        )
    }
}

impl Request {
    pub(crate) fn parse(value: Value) -> Result<Self, JobError> {
        if serde_json::to_vec(&value).map_or(true, |bytes| {
            bytes.len() > hertz_desktop_ipc::management::REQUEST_LIMIT
        }) {
            return Err(JobError::invalid_input("请求超过 16 KiB"));
        }
        let request: Self = serde_json::from_value(value)
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
        if request.protocol != 2 {
            return Err(JobError::new(
                "unsupported_protocol",
                "壁纸管理需要 protocol=2",
            ));
        }
        if !valid_id(&request.request_id) {
            return Err(JobError::invalid_input("requestId 必须是有界的可打印标识"));
        }
        request.typed()?;
        Ok(request)
    }

    pub(crate) fn digest(&self) -> String {
        let value = json!({"command":self.command,"expectedRevision":self.expected_revision,"payload":self.payload});
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&value).expect("JSON value"))
        )
    }

    pub(crate) fn typed(&self) -> Result<Command, JobError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Empty {}
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct List {
            #[serde(default = "default_limit")]
            limit: u32,
            #[serde(default)]
            cursor: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Work {
            work_key: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct File {
            file_token: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Job {
            job_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Operation {
            request_id: String,
            #[serde(default)]
            command: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Create {
            kind: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Draft {
            draft_id: String,
            draft_revision: u64,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Update {
            draft_id: String,
            draft_revision: u64,
            operations: Vec<super::settings_drafts::Update>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Preview {
            lease_id: String,
            draft_id: String,
            draft_revision: u64,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Lease {
            lease_id: String,
        }
        fn draft(value: Draft) -> Result<Draft, JobError> {
            id(value.draft_id.clone())?;
            if value.draft_revision == 0 {
                return Err(JobError::invalid_input("缺少有效草稿修订号"));
            }
            Ok(value)
        }
        fn default_limit() -> u32 {
            50
        }
        fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, JobError> {
            serde_json::from_value(if value.is_null() {
                json!({})
            } else {
                value.clone()
            })
            .map_err(|error| JobError::invalid_input(error.to_string()))
        }
        fn id(value: String) -> Result<String, JobError> {
            if valid_id(&value) {
                Ok(value)
            } else {
                Err(JobError::invalid_input("标识格式无效"))
            }
        }
        Ok(match self.command.as_str() {
            "wallpaper.draft.create" => {
                let value: Create = decode(&self.payload)?;
                if value.kind != "settings" {
                    return Err(JobError::new(
                        "unsupported_draft_kind",
                        "当前版本仅支持设置草稿",
                    ));
                }
                Command::DraftCreate
            }
            "wallpaper.draft.update" => {
                let value: Update = decode(&self.payload)?;
                let reference = draft(Draft {
                    draft_id: value.draft_id,
                    draft_revision: value.draft_revision,
                })?;
                if value.operations.is_empty() || value.operations.len() > 32 {
                    return Err(JobError::invalid_input("每次需提供 1–32 个类型化修改"));
                }
                Command::DraftUpdate {
                    draft_id: reference.draft_id,
                    draft_revision: reference.draft_revision,
                    operations: value.operations,
                }
            }
            "wallpaper.draft.discard" | "wallpaper.apply" | "wallpaper.preview.acquire" => {
                let value = draft(decode(&self.payload)?)?;
                match self.command.as_str() {
                    "wallpaper.draft.discard" => Command::DraftDiscard {
                        draft_id: value.draft_id,
                        draft_revision: value.draft_revision,
                    },
                    "wallpaper.apply" => {
                        if self.expected_revision.is_none() {
                            return Err(JobError::invalid_input("应用必须提供 expectedRevision"));
                        }
                        Command::Apply {
                            draft_id: value.draft_id,
                            draft_revision: value.draft_revision,
                        }
                    }
                    _ => Command::PreviewAcquire {
                        draft_id: value.draft_id,
                        draft_revision: value.draft_revision,
                    },
                }
            }
            "wallpaper.preview.update" => {
                let value: Preview = decode(&self.payload)?;
                let reference = draft(Draft {
                    draft_id: value.draft_id,
                    draft_revision: value.draft_revision,
                })?;
                Command::PreviewUpdate {
                    lease_id: id(value.lease_id)?,
                    draft_id: reference.draft_id,
                    draft_revision: reference.draft_revision,
                }
            }
            "wallpaper.preview.renew" | "wallpaper.preview.release" => {
                let value: Lease = decode(&self.payload)?;
                if self.command == "wallpaper.preview.renew" {
                    Command::PreviewRenew {
                        lease_id: id(value.lease_id)?,
                    }
                } else {
                    Command::PreviewRelease {
                        lease_id: id(value.lease_id)?,
                    }
                }
            }
            "wallpaper.capabilities" => {
                let _: Empty = decode(&self.payload)?;
                Command::Capabilities
            }
            "wallpaper.status" => {
                let _: Empty = decode(&self.payload)?;
                Command::Status
            }
            "wallpaper.file.pick" => {
                let _: Empty = decode(&self.payload)?;
                Command::FilePick
            }
            "wallpaper.library.list" => {
                let value: List = decode(&self.payload)?;
                if !(1..=50).contains(&value.limit)
                    || value
                        .cursor
                        .as_ref()
                        .is_some_and(|cursor| cursor.len() > 256)
                {
                    return Err(JobError::invalid_input("分页大小或游标超过限制"));
                }
                Command::LibraryList {
                    limit: value.limit,
                    cursor: value.cursor,
                }
            }
            "wallpaper.library.get" => {
                let value: Work = decode(&self.payload)?;
                Command::LibraryGet {
                    work_key: id(value.work_key)?,
                }
            }
            "wallpaper.import.begin" => {
                let value: File = decode(&self.payload)?;
                if value.file_token.len() != 32
                    || !value
                        .file_token
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(JobError::invalid_input("文件令牌格式无效"));
                }
                Command::ImportBegin {
                    file_token: value.file_token,
                }
            }
            "wallpaper.jobs.get" => {
                let value: Job = decode(&self.payload)?;
                Command::JobsGet {
                    job_id: id(value.job_id)?,
                }
            }
            "wallpaper.jobs.cancel" => {
                let value: Job = decode(&self.payload)?;
                Command::JobsCancel {
                    job_id: id(value.job_id)?,
                }
            }
            "wallpaper.operations.get" => {
                let value: Operation = decode(&self.payload)?;
                if value.command.as_ref().is_some_and(|command| {
                    !matches!(
                        command.as_str(),
                        "wallpaper.apply" | "config.commit" | "wallpaper.import.begin"
                    )
                }) {
                    return Err(JobError::invalid_input("不支持的持久操作类别"));
                }
                Command::OperationsGet {
                    request_id: id(value.request_id)?,
                    command: value.command,
                }
            }
            _ => return Err(JobError::new("unsupported_command", "此壁纸命令尚未提供")),
        })
    }
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(crate) fn response(
    request_id: Option<&str>,
    result: Result<Value, JobError>,
    job_id: Option<&str>,
) -> Value {
    let (ok, result, error) = match result {
        Ok(value) => (true, value, Value::Null),
        Err(error) => (
            false,
            Value::Null,
            json!({"code":error.code,"message":error.message.chars().take(2000).collect::<String>(),"retryable":matches!(error.code,"budget_busy"|"service_starting"|"operation_pending"|"query_timeout"|"journal_full"|"config_busy"),"field":null,"details":null}),
        ),
    };
    json!({"protocol":2,"requestId":request_id.filter(|id|valid_id(id)),"ok":ok,"configRevision":null,"jobId":job_id,"result":result,"error":error})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelope_is_strict_and_never_accepts_local_paths_or_unbounded_pages() {
        let request = |command: &str, payload: Value| json!({"protocol":2,"requestId":"test-1","command":command,"payload":payload});
        assert!(Request::parse(request("wallpaper.library.list", json!({}))).is_ok());
        assert!(Request::parse(request(
            "wallpaper.import.begin",
            json!({"path":"C:/secret.hwpkg"})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.file.pick",
            json!({"path":"C:/secret.hwpkg"})
        ))
        .is_err());
        assert!(Request::parse(request("wallpaper.library.list", json!({"limit":51}))).is_err());
        assert!(Request::parse(request(
            "wallpaper.jobs.get",
            json!({"jobId":"a","root":"C:/"})
        ))
        .is_err());
        assert_eq!(
            Request::parse(request("wallpaper.unknown", json!({})))
                .unwrap_err()
                .code,
            "unsupported_command"
        );
    }
    #[test]
    fn settings_commands_require_typed_references_and_explicit_apply_revision() {
        let request = |command: &str, payload: Value| json!({"protocol":2,"requestId":"typed-draft","command":command,"payload":payload});
        assert!(Request::parse(request(
            "wallpaper.draft.create",
            json!({"kind":"settings"})
        ))
        .is_ok());
        assert!(Request::parse(request("wallpaper.draft.create", json!({"kind":"work"}))).is_err());
        assert!(Request::parse(request("wallpaper.draft.update",json!({"draftId":"a","draftRevision":1,"operations":[{"kind":"script","source":"evil()"}]}))).is_err());
        assert!(Request::parse(request(
            "wallpaper.apply",
            json!({"draftId":"a","draftRevision":1})
        ))
        .is_err());
        let mut apply = request("wallpaper.apply", json!({"draftId":"a","draftRevision":1}));
        apply["expectedRevision"] = json!(1);
        assert!(Request::parse(apply).is_ok());
        assert!(Request::parse(request(
            "wallpaper.preview.renew",
            json!({"leaseId":"a","owner":1})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.operations.get",
            json!({"requestId":"a","command":"wallpaper.import.begin"})
        ))
        .is_ok());
        assert!(Request::parse(request(
            "wallpaper.operations.get",
            json!({"requestId":"a","command":"arbitrary"})
        ))
        .is_err());
    }

    #[test]
    fn receipt_has_fixed_fields_and_digest_binds_all_effects() {
        let a=Request::parse(json!({"protocol":2,"requestId":"one","command":"wallpaper.jobs.get","payload":{"jobId":"a"}})).unwrap();
        let mut b = a.clone();
        b.request_id = "two".into();
        assert_eq!(a.digest(), b.digest());
        b.payload = json!({"jobId":"b"});
        assert_ne!(a.digest(), b.digest());
        let receipt = response(Some("bad id"), Err(JobError::invalid_input("bad")), None);
        assert_eq!(receipt.as_object().unwrap().len(), 7);
        assert!(receipt["requestId"].is_null());
        assert!(receipt["configRevision"].is_null());
        assert_eq!(receipt["error"]["code"], "invalid_input");
    }
}
