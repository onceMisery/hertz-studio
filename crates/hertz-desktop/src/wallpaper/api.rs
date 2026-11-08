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
    WorkDraftCreate {
        document: super::work_drafts::Document,
    },
    WorkDraftOpen {
        work_key: String,
        package_hash: String,
    },
    WorkDraftList {
        limit: u32,
        cursor: Option<String>,
    },
    WorkDraftGet {
        draft_id: String,
    },
    WorkDraftSchema {
        scene_id: String,
    },
    WorkDraftParameters {
        draft_id: String,
        draft_revision: u64,
        cursor: Option<String>,
        limit: u32,
    },
    WorkDraftProperties {
        draft_id: String,
        draft_revision: u64,
        cursor: Option<String>,
        limit: u32,
    },
    WorkDraftUpdate {
        draft_id: String,
        draft_revision: u64,
        operations: Vec<super::work_drafts::Update>,
    },
    WorkDraftSave {
        draft_id: String,
        draft_revision: u64,
    },
    WorkDraftPublish {
        draft_id: String,
        draft_revision: u64,
    },
    WorkDraftDiscard {
        draft_id: String,
        draft_revision: u64,
    },
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
        group_id: Option<String>,
    },
    PreviewUpdate {
        lease_id: String,
        draft_id: String,
        draft_revision: u64,
        group_id: Option<String>,
    },
    PreviewRenew {
        lease_id: String,
    },
    PreviewRelease {
        lease_id: String,
    },
    Capabilities,
    LayoutInspect {
        selection: super::config::Selection,
        members: usize,
    },
    PropertiesInspect {
        selection: super::config::Selection,
        limit: u32,
        cursor: Option<String>,
    },
    Status,
    LibraryList {
        limit: u32,
        cursor: Option<String>,
        favorites_only: bool,
    },
    LibraryGet {
        work_key: String,
    },
    LibraryReferences {
        work_key: String,
        package_hash: Option<String>,
    },
    LibraryPoster {
        work_key: String,
        package_hash: String,
    },
    LibraryFavorite {
        work_key: String,
        favorite: bool,
    },
    LibraryDeleteWork {
        work_key: String,
    },
    LibraryDeleteVersion {
        work_key: String,
        version: u32,
        package_hash: String,
    },
    FilePick,
    ExportPick {
        package_hash: String,
    },
    ExportBegin {
        package_hash: String,
        output_token: String,
    },
    ExportRecover {
        job_id: String,
    },
    PlaylistList {
        limit: u32,
        cursor: Option<String>,
    },
    PlaylistGet {
        playlist_id: String,
    },
    PlaylistSave {
        playlist_id: Option<String>,
        expected_playlist_revision: Option<u64>,
        title: String,
        mode: super::playlist::Mode,
        interval_seconds: u32,
        items: Vec<super::playlist::FixedVersion>,
    },
    PlaylistNext {
        playlist_id: String,
        retry: bool,
        group_id: Option<String>,
    },
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
                | Self::PlaylistNext { .. }
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
        struct LayoutInspect {
            selection: super::config::Selection,
            members: usize,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PropertiesInspect {
            selection: super::config::Selection,
            #[serde(default = "default_limit")]
            limit: u32,
            #[serde(default)]
            cursor: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct List {
            #[serde(default = "default_limit")]
            limit: u32,
            #[serde(default)]
            cursor: Option<String>,
            #[serde(default)]
            favorites_only: bool,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct SmallList {
            #[serde(default = "small_limit")]
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
        struct References {
            work_key: String,
            #[serde(default)]
            package_hash: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Favorite {
            work_key: String,
            favorite: bool,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Poster {
            work_key: String,
            package_hash: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Version {
            work_key: String,
            version: u32,
            package_hash: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct File {
            file_token: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ExportPick {
            package_hash: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ExportBegin {
            package_hash: String,
            output_token: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PlaylistId {
            playlist_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PlaylistSave {
            #[serde(default)]
            playlist_id: Option<String>,
            #[serde(default)]
            expected_playlist_revision: Option<u64>,
            title: String,
            mode: super::playlist::Mode,
            interval_seconds: u32,
            items: Vec<super::playlist::FixedVersion>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PlaylistNext {
            playlist_id: String,
            #[serde(default)]
            retry: bool,
            #[serde(default)]
            group_id: Option<String>,
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
            #[serde(default)]
            document: Option<super::work_drafts::Document>,
            #[serde(default)]
            work_key: Option<String>,
            #[serde(default)]
            package_hash: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Draft {
            draft_id: String,
            draft_revision: u64,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Acquire {
            draft_id: String,
            draft_revision: u64,
            #[serde(default)]
            group_id: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Update {
            draft_id: String,
            draft_revision: u64,
            operations: Vec<Value>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct DraftGet {
            draft_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Scene {
            scene_id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct DraftParameters {
            draft_id: String,
            draft_revision: u64,
            #[serde(default)]
            cursor: Option<String>,
            #[serde(default = "default_limit")]
            limit: u32,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Preview {
            lease_id: String,
            draft_id: String,
            draft_revision: u64,
            #[serde(default)]
            group_id: Option<String>,
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
        fn small_limit() -> u32 {
            20
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
        fn package_hash(value: String) -> Result<String, JobError> {
            if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                Ok(value.to_ascii_lowercase())
            } else {
                Err(JobError::invalid_input("包 hash 格式无效"))
            }
        }
        Ok(match self.command.as_str() {
            "wallpaper.draft.create" => {
                let value: Create = decode(&self.payload)?;
                match (
                    value.kind.as_str(),
                    value.document,
                    value.work_key,
                    value.package_hash,
                ) {
                    ("settings", None, None, None) => Command::DraftCreate,
                    ("work", Some(document), None, None) => Command::WorkDraftCreate { document },
                    ("work", None, Some(work_key), Some(hash)) => Command::WorkDraftOpen {
                        work_key: id(work_key)?,
                        package_hash: package_hash(hash)?,
                    },
                    _ => return Err(JobError::invalid_input("草稿类型或初始作品不完整")),
                }
            }
            "wallpaper.draft.list" => {
                let value: SmallList = decode(&self.payload)?;
                if !(1..=20).contains(&value.limit)
                    || value.cursor.as_ref().is_some_and(|s| s.len() > 128)
                {
                    return Err(JobError::invalid_input("草稿分页参数无效（每页最多20项）"));
                }
                Command::WorkDraftList {
                    limit: value.limit,
                    cursor: value.cursor,
                }
            }
            "wallpaper.draft.get" => {
                let value: DraftGet = decode(&self.payload)?;
                Command::WorkDraftGet {
                    draft_id: id(value.draft_id)?,
                }
            }
            "wallpaper.draft.schema" => {
                let value: Scene = decode(&self.payload)?;
                Command::WorkDraftSchema {
                    scene_id: id(value.scene_id)?,
                }
            }
            "wallpaper.draft.parameters" | "wallpaper.draft.properties" => {
                let value: DraftParameters = decode(&self.payload)?;
                let reference = draft(Draft {
                    draft_id: value.draft_id,
                    draft_revision: value.draft_revision,
                })?;
                if !(1..=50).contains(&value.limit)
                    || value.cursor.as_ref().is_some_and(|s| s.len() > 128)
                {
                    return Err(JobError::invalid_input("参数分页超过限制"));
                }
                if self.command == "wallpaper.draft.properties" {
                    Command::WorkDraftProperties {
                        draft_id: reference.draft_id,
                        draft_revision: reference.draft_revision,
                        cursor: value.cursor,
                        limit: value.limit,
                    }
                } else {
                    Command::WorkDraftParameters {
                        draft_id: reference.draft_id,
                        draft_revision: reference.draft_revision,
                        cursor: value.cursor,
                        limit: value.limit,
                    }
                }
            }
            "wallpaper.draft.save" | "wallpaper.draft.publish" => {
                let value = draft(decode(&self.payload)?)?;
                if !value.draft_id.starts_with("work-") {
                    return Err(JobError::invalid_input("保存工程与生成版本只接受作品草稿"));
                }
                if self.command == "wallpaper.draft.save" {
                    Command::WorkDraftSave {
                        draft_id: value.draft_id,
                        draft_revision: value.draft_revision,
                    }
                } else {
                    Command::WorkDraftPublish {
                        draft_id: value.draft_id,
                        draft_revision: value.draft_revision,
                    }
                }
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
                if reference.draft_id.starts_with("work-") {
                    Command::WorkDraftUpdate {
                        draft_id: reference.draft_id,
                        draft_revision: reference.draft_revision,
                        operations: decode(&Value::Array(value.operations))?,
                    }
                } else {
                    Command::DraftUpdate {
                        draft_id: reference.draft_id,
                        draft_revision: reference.draft_revision,
                        operations: decode(&Value::Array(value.operations))?,
                    }
                }
            }
            "wallpaper.draft.discard" | "wallpaper.apply" => {
                let value = draft(decode(&self.payload)?)?;
                match self.command.as_str() {
                    "wallpaper.draft.discard" if value.draft_id.starts_with("work-") => {
                        Command::WorkDraftDiscard {
                            draft_id: value.draft_id,
                            draft_revision: value.draft_revision,
                        }
                    }
                    "wallpaper.draft.discard" => Command::DraftDiscard {
                        draft_id: value.draft_id,
                        draft_revision: value.draft_revision,
                    },
                    _ => {
                        if self.expected_revision.is_none() {
                            return Err(JobError::invalid_input("应用必须提供 expectedRevision"));
                        }
                        Command::Apply {
                            draft_id: value.draft_id,
                            draft_revision: value.draft_revision,
                        }
                    }
                }
            }
            "wallpaper.preview.acquire" => {
                let value: Acquire = decode(&self.payload)?;
                let reference = draft(Draft {
                    draft_id: value.draft_id,
                    draft_revision: value.draft_revision,
                })?;
                Command::PreviewAcquire {
                    draft_id: reference.draft_id,
                    draft_revision: reference.draft_revision,
                    group_id: value.group_id.map(id).transpose()?,
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
                    group_id: value.group_id.map(id).transpose()?,
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
            "wallpaper.layout.inspect" => {
                let mut value: LayoutInspect = decode(&self.payload)?;
                if !(1..=4).contains(&value.members) {
                    return Err(JobError::invalid_input("布局检查需要 1–4 个显示器"));
                }
                match &mut value.selection {
                    super::config::Selection::Builtin {
                        scene_id,
                        state_version,
                        params,
                    } => super::config::normalize_builtin(scene_id, *state_version, params)
                        .map_err(|error| JobError::invalid_input(error.to_string()))?,
                    super::config::Selection::FollowHertz { idle_builtin } => {
                        super::config::normalize_builtin(
                            &idle_builtin.scene_id,
                            idle_builtin.state_version,
                            &mut idle_builtin.params,
                        )
                        .map_err(|error| JobError::invalid_input(error.to_string()))?;
                    }
                    super::config::Selection::Package {
                        work_key,
                        package_hash: hash,
                    } => {
                        if !valid_selection_id(work_key) {
                            return Err(JobError::invalid_input("作品身份无效"));
                        }
                        *hash = package_hash(hash.clone())?;
                    }
                    super::config::Selection::Playlist { playlist_id } => {
                        if !valid_selection_id(playlist_id) {
                            return Err(JobError::invalid_input("轮播列表身份无效"));
                        }
                    }
                }
                Command::LayoutInspect {
                    selection: value.selection,
                    members: value.members,
                }
            }
            "wallpaper.properties.inspect" => {
                let value: PropertiesInspect = decode(&self.payload)?;
                if value
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.len() > 256)
                {
                    return Err(JobError::invalid_input("公开属性分页游标超限"));
                }
                match &value.selection {
                    super::config::Selection::Package {
                        work_key,
                        package_hash: hash,
                    } if valid_selection_id(work_key)
                        && hertz_wallpaper::valid_sha256_hex(hash) => {}
                    super::config::Selection::Playlist { playlist_id }
                        if valid_selection_id(playlist_id) => {}
                    _ => return Err(JobError::invalid_input("公开属性需要作品版本或轮播列表")),
                }
                Command::PropertiesInspect {
                    selection: value.selection,
                    limit: value.limit.clamp(1, 32),
                    cursor: value.cursor,
                }
            }
            "wallpaper.status" => {
                let _: Empty = decode(&self.payload)?;
                Command::Status
            }
            "wallpaper.file.pick" => {
                let _: Empty = decode(&self.payload)?;
                Command::FilePick
            }
            "wallpaper.export.pick" => {
                let value: ExportPick = decode(&self.payload)?;
                Command::ExportPick {
                    package_hash: package_hash(value.package_hash)?,
                }
            }
            "wallpaper.export.begin" => {
                let value: ExportBegin = decode(&self.payload)?;
                if value.output_token.len() != 32
                    || !value.output_token.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(JobError::invalid_input("输出令牌格式无效"));
                }
                Command::ExportBegin {
                    package_hash: package_hash(value.package_hash)?,
                    output_token: value.output_token,
                }
            }
            "wallpaper.export.recover" => {
                let value: Job = decode(&self.payload)?;
                Command::ExportRecover {
                    job_id: id(value.job_id)?,
                }
            }
            "wallpaper.playlist.list" => {
                let value: SmallList = decode(&self.payload)?;
                if !(1..=20).contains(&value.limit)
                    || value.cursor.as_ref().is_some_and(|s| !valid_id(s))
                {
                    return Err(JobError::invalid_input("轮播列表分页参数无效"));
                }
                Command::PlaylistList {
                    limit: value.limit,
                    cursor: value.cursor,
                }
            }
            "wallpaper.playlist.get" => {
                let value: PlaylistId = decode(&self.payload)?;
                Command::PlaylistGet {
                    playlist_id: id(value.playlist_id)?,
                }
            }
            "wallpaper.playlist.save" => {
                let value: PlaylistSave = decode(&self.payload)?;
                if value.items.is_empty()
                    || value.items.len() > 32
                    || !(10..=86400).contains(&value.interval_seconds)
                {
                    return Err(JobError::invalid_input(
                        "轮播需要1–32个固定版本，间隔10–86400秒",
                    ));
                }
                Command::PlaylistSave {
                    playlist_id: value.playlist_id.map(id).transpose()?,
                    expected_playlist_revision: value.expected_playlist_revision,
                    title: value.title,
                    mode: value.mode,
                    interval_seconds: value.interval_seconds,
                    items: value.items,
                }
            }
            "wallpaper.playlist.next" => {
                let value: PlaylistNext = decode(&self.payload)?;
                Command::PlaylistNext {
                    playlist_id: id(value.playlist_id)?,
                    retry: value.retry,
                    group_id: value.group_id.map(id).transpose()?,
                }
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
                    favorites_only: value.favorites_only,
                }
            }
            "wallpaper.library.get" => {
                let value: Work = decode(&self.payload)?;
                Command::LibraryGet {
                    work_key: id(value.work_key)?,
                }
            }
            "wallpaper.library.references" => {
                let value: References = decode(&self.payload)?;
                Command::LibraryReferences {
                    work_key: id(value.work_key)?,
                    package_hash: value.package_hash.map(package_hash).transpose()?,
                }
            }
            "wallpaper.library.favorite" => {
                let value: Favorite = decode(&self.payload)?;
                Command::LibraryFavorite {
                    work_key: id(value.work_key)?,
                    favorite: value.favorite,
                }
            }
            "wallpaper.library.poster" => {
                let value: Poster = decode(&self.payload)?;
                Command::LibraryPoster {
                    work_key: id(value.work_key)?,
                    package_hash: package_hash(value.package_hash)?,
                }
            }
            "wallpaper.library.deleteWork" => {
                let value: Work = decode(&self.payload)?;
                Command::LibraryDeleteWork {
                    work_key: id(value.work_key)?,
                }
            }
            "wallpaper.library.deleteVersion" => {
                let value: Version = decode(&self.payload)?;
                if value.version == 0 {
                    return Err(JobError::invalid_input("版本号必须为正整数"));
                }
                Command::LibraryDeleteVersion {
                    work_key: id(value.work_key)?,
                    version: value.version,
                    package_hash: package_hash(value.package_hash)?,
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
                        "wallpaper.apply"
                            | "wallpaper.ai.recommend"
                            | "wallpaper.ai.confirm"
                            | "config.commit"
                            | "wallpaper.import.begin"
                            | "wallpaper.export.begin"
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

pub(crate) fn valid_selection_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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
            json!({"code":error.code,"message":error.message.chars().take(2000).collect::<String>(),"retryable":matches!(error.code,"budget_busy"|"service_starting"|"operation_pending"|"query_timeout"|"journal_full"|"config_busy"),"field":null,"details":error.details}),
        ),
    };
    json!({"protocol":2,"requestId":request_id.filter(|id|valid_id(id)),"ok":ok,"configRevision":null,"jobId":job_id,"result":result,"error":error})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_queries_bind_work_and_optional_hash_without_mutation_fields() {
        let request = |payload| {
            Request::parse(
                json!({"protocol":2,"requestId":"references-test","command":"wallpaper.library.references","payload":payload}),
            )
        };
        assert!(matches!(
            request(json!({"workKey":"work-a"}))
                .unwrap()
                .typed()
                .unwrap(),
            Command::LibraryReferences {
                package_hash: None,
                ..
            }
        ));
        assert!(
            matches!(request(json!({"workKey":"work-a","packageHash":"A".repeat(64)})).unwrap().typed().unwrap(), Command::LibraryReferences { package_hash: Some(hash), .. } if hash == "a".repeat(64))
        );
        for payload in [
            json!({}),
            json!({"workKey":"work-a","packageHash":"bad"}),
            json!({"workKey":"work-a","version":1}),
            json!({"workKey":"work-a","delete":true}),
        ] {
            assert!(request(payload).is_err());
        }
    }

    #[test]
    fn layout_inspection_requires_bounded_typed_selection_and_member_count() {
        let request = |payload: Value| {
            Request::parse(json!({
                "protocol":2,"requestId":"inspect-layout","command":"wallpaper.layout.inspect",
                "payload":payload
            }))
        };
        let package = json!({"kind":"package","workKey":"work-1","packageHash":"A".repeat(64)});
        for members in 1..=4 {
            match request(json!({"selection":package.clone(),"members":members}))
                .unwrap()
                .typed()
                .unwrap()
            {
                Command::LayoutInspect {
                    selection: super::super::config::Selection::Package { package_hash, .. },
                    members: actual,
                } => {
                    assert_eq!(actual, members);
                    assert_eq!(package_hash, "a".repeat(64));
                }
                _ => panic!("expected a typed inspection"),
            }
        }
        for members in [
            json!(0),
            json!(5),
            json!(-1),
            json!(1.5),
            json!("2"),
            Value::Null,
        ] {
            assert!(request(json!({"selection":package.clone(),"members":members})).is_err());
        }
        for payload in [
            json!({"selection":package.clone()}),
            json!({"members":2}),
            json!({"selection":package.clone(),"members":2,"properties":{}}),
            json!({"selection":package.clone(),"members":2,"path":"C:/media.png"}),
        ] {
            assert!(request(payload).is_err());
        }
        for selection in [
            json!({"kind":"package","workKey":"work-1","packageHash":"short"}),
            json!({"kind":"package","workKey":"work-1","packageHash":"a".repeat(64),"kindHint":"image"}),
            json!({"kind":"playlist","playlistId":"list-1","items":[]}),
            json!({"kind":"image","url":"https://example.test/media.png"}),
            json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{},"properties":{}}),
            json!({"kind":"builtin","sceneId":"coast","stateVersion":0,"params":{}}),
            json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{"unknown":1}}),
            json!({"kind":"followHertz","idleBuiltin":{"sceneId":"coast","stateVersion":1,"params":{},"path":"C:/"}}),
        ] {
            assert!(request(json!({"selection":selection,"members":2})).is_err());
        }
        for invalid in [
            "".to_owned(),
            "has space".into(),
            "../outside".into(),
            "x".repeat(129),
        ] {
            for selection in [
                json!({"kind":"package","workKey":invalid,"packageHash":"a".repeat(64)}),
                json!({"kind":"playlist","playlistId":invalid}),
            ] {
                assert!(request(json!({"selection":selection,"members":2})).is_err());
            }
        }
        for selection in [
            json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}}),
            json!({"kind":"followHertz","idleBuiltin":{"sceneId":"coast","stateVersion":1,"params":{}}}),
            json!({"kind":"playlist","playlistId":"playlist-1"}),
        ] {
            let parsed = request(json!({"selection":selection,"members":2})).unwrap();
            assert!(!parsed.typed().unwrap().settings_command());
        }
    }

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
    fn preview_commands_accept_group_context_and_preserve_legacy_requests() {
        for draft_id in ["settings-draft", "work-draft"] {
            for command in ["wallpaper.preview.acquire", "wallpaper.preview.update"] {
                let mut payload = json!({"draftId":draft_id,"draftRevision":3});
                if command == "wallpaper.preview.update" {
                    payload["leaseId"] = json!("preview-lease");
                }
                let request = |payload: Value| {
                    Request::parse(json!({
                        "protocol":2,"requestId":"preview-group","command":command,
                        "payload":payload
                    }))
                    .unwrap()
                };
                let legacy = request(payload.clone());
                assert!(matches!(
                    legacy.typed().unwrap(),
                    Command::PreviewAcquire { group_id: None, .. }
                        | Command::PreviewUpdate { group_id: None, .. }
                ));
                payload["groupId"] = json!("secondary");
                let selected = request(payload);
                match selected.typed().unwrap() {
                    Command::PreviewAcquire {
                        draft_id: actual_draft,
                        draft_revision,
                        group_id,
                    }
                    | Command::PreviewUpdate {
                        draft_id: actual_draft,
                        draft_revision,
                        group_id,
                        ..
                    } => {
                        assert_eq!(actual_draft, draft_id);
                        assert_eq!(draft_revision, 3);
                        assert_eq!(group_id.as_deref(), Some("secondary"));
                    }
                    _ => panic!("expected preview command"),
                }
                assert_ne!(legacy.digest(), selected.digest());
            }
        }
    }

    #[test]
    fn preview_group_context_is_strict_and_does_not_expand_other_commands() {
        let request = |command: &str, payload: Value| {
            json!({
                "protocol":2,"requestId":"preview-strict","command":command,
                "expectedRevision":1,"payload":payload
            })
        };
        for command in ["wallpaper.preview.acquire", "wallpaper.preview.update"] {
            let mut payload = json!({"draftId":"settings-draft","draftRevision":1});
            if command == "wallpaper.preview.update" {
                payload["leaseId"] = json!("preview-lease");
            }
            for invalid in [
                json!(""),
                json!("bad group"),
                json!("g".repeat(129)),
                json!(7),
            ] {
                let mut invalid_payload = payload.clone();
                invalid_payload["groupId"] = invalid;
                assert!(Request::parse(request(command, invalid_payload)).is_err());
            }
            payload["groupId"] = json!("secondary");
            payload["groupIndex"] = json!(1);
            assert!(Request::parse(request(command, payload)).is_err());
        }
        for command in ["wallpaper.draft.discard", "wallpaper.apply"] {
            assert!(Request::parse(request(
                command,
                json!({"draftId":"settings-draft","draftRevision":1,"groupId":"secondary"})
            ))
            .is_err());
        }
    }

    #[test]
    fn playlist_next_and_retry_accept_optional_group_routing() {
        let request = |payload: Value| {
            Request::parse(json!({
                "protocol":2,"requestId":"playlist-group","command":"wallpaper.playlist.next",
                "payload":payload
            }))
        };
        assert!(matches!(
            request(json!({"playlistId":"list-a"}))
                .unwrap()
                .typed()
                .unwrap(),
            Command::PlaylistNext {
                retry: false,
                group_id: None,
                ..
            }
        ));
        for retry in [false, true] {
            let legacy = request(json!({"playlistId":"list-a","retry":retry})).unwrap();
            assert!(matches!(
                legacy.typed().unwrap(),
                Command::PlaylistNext { group_id: None, .. }
            ));
            let selected = request(json!({
                "playlistId":"list-a","retry":retry,"groupId":"secondary"
            }))
            .unwrap();
            match selected.typed().unwrap() {
                Command::PlaylistNext {
                    playlist_id,
                    retry: actual_retry,
                    group_id,
                } => {
                    assert_eq!(playlist_id, "list-a");
                    assert_eq!(actual_retry, retry);
                    assert_eq!(group_id.as_deref(), Some("secondary"));
                }
                _ => panic!("expected playlist next command"),
            }
            assert_ne!(legacy.digest(), selected.digest());
            for invalid in [
                json!(""),
                json!("bad group"),
                json!("g".repeat(129)),
                json!(7),
            ] {
                assert!(request(json!({
                    "playlistId":"list-a","retry":retry,"groupId":invalid
                }))
                .is_err());
            }
            assert!(request(json!({
                "playlistId":"list-a","retry":retry,"groupId":"secondary","groupIndex":1
            }))
            .is_err());
        }
    }

    #[test]
    fn library_delete_requires_typed_version_and_package_hash() {
        let request = |command: &str, payload: Value| json!({"protocol":2,"requestId":"delete-1","command":command,"payload":payload});
        let hash = "a".repeat(64);
        assert!(Request::parse(request(
            "wallpaper.library.deleteWork",
            json!({"workKey":"w-1"})
        ))
        .is_ok());
        assert!(Request::parse(request(
            "wallpaper.library.deleteVersion",
            json!({"workKey":"w-1","version":2,"packageHash":hash})
        ))
        .is_ok());
        assert!(Request::parse(request(
            "wallpaper.library.deleteVersion",
            json!({"workKey":"w-1","version":0,"packageHash":hash})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.library.deleteVersion",
            json!({"workKey":"w-1","version":2,"packageHash":"short"})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.library.deleteVersion",
            json!({"workKey":"w-1","version":2,"packageHash":hash,"path":"C:/secret"})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.library.deleteWork",
            json!({"workKey":""})
        ))
        .is_err());
    }

    #[test]
    fn library_favorite_and_filter_are_typed() {
        let request = |command: &str, payload: Value| json!({"protocol":2,"requestId":"favorite-1","command":command,"payload":payload});
        assert!(Request::parse(request(
            "wallpaper.library.list",
            json!({"favoritesOnly":true})
        ))
        .is_ok());
        assert!(Request::parse(request(
            "wallpaper.library.list",
            json!({"favoritesOnly":"yes"})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.library.favorite",
            json!({"workKey":"w-1","favorite":true})
        ))
        .is_ok());
        assert!(Request::parse(request(
            "wallpaper.library.favorite",
            json!({"workKey":"w-1","favorite":1})
        ))
        .is_err());
        assert!(Request::parse(request(
            "wallpaper.library.favorite",
            json!({"workKey":"w-1"})
        ))
        .is_err());
    }

    #[test]
    fn poster_reads_require_exact_version_identity_and_reject_paths() {
        let request = |payload: Value| json!({"protocol":2,"requestId":"poster-1","command":"wallpaper.library.poster","payload":payload});
        let hash = "a".repeat(64);
        assert!(Request::parse(request(json!({"workKey":"work","packageHash":hash}))).is_ok());
        assert!(Request::parse(request(json!({"workKey":"work"}))).is_err());
        assert!(Request::parse(request(
            json!({"workKey":"work","packageHash":"../outside"})
        ))
        .is_err());
        assert!(Request::parse(request(
            json!({"workKey":"work","packageHash":hash,"path":"C:/secret"})
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

    #[test]
    fn work_properties_require_typed_deltas_and_bounded_revision_queries() {
        let request = |command: &str, payload: Value| {
            Request::parse(json!({
                "protocol":2, "requestId":"property-test", "command":command, "payload":payload
            }))
        };
        let draft_id = format!("work-{}", "a".repeat(32));
        assert!(matches!(
            request(
                "wallpaper.draft.properties",
                json!({"draftId":draft_id,"draftRevision":1,"limit":3})
            )
            .unwrap()
            .typed()
            .unwrap(),
            Command::WorkDraftProperties { limit: 3, .. }
        ));
        for payload in [
            json!({"draftId":draft_id,"draftRevision":0}),
            json!({"draftId":draft_id,"draftRevision":1,"limit":51}),
            json!({"draftId":draft_id,"draftRevision":1,"cursor":"a".repeat(129)}),
            json!({"draftId":draft_id,"draftRevision":1,"properties":[]}),
        ] {
            assert!(request("wallpaper.draft.properties", payload).is_err());
        }
        let property = hertz_wallpaper::properties::builtin_property(
            "coast",
            1,
            "discRing",
            "disc-ring",
            "环绕频谱",
            json!(true),
        )
        .unwrap();
        assert!(request("wallpaper.draft.update", json!({"draftId":draft_id,"draftRevision":1,"operations":[{"kind":"setProperty","property":property}]})).is_ok());
        assert!(request("wallpaper.draft.update", json!({"draftId":draft_id,"draftRevision":1,"operations":[{"kind":"removeProperty","id":"disc-ring"}]})).is_ok());
        let mut malformed = serde_json::to_value(property).unwrap();
        malformed["target"]
            .as_object_mut()
            .unwrap()
            .remove("component");
        assert!(request("wallpaper.draft.update", json!({"draftId":draft_id,"draftRevision":1,"operations":[{"kind":"setProperty","property":malformed}]})).is_err());
    }
}
