// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Persistent, bounded builtin work documents. Draft CAS, saved snapshots and
//! immutable published versions are separate facts; this module never writes Config.

use std::io::{Cursor, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::FromRow;

use super::assets::AssetStore;
use super::jobs::JobError;
use super::library::{now_secs, Library};

type Result<T> = std::result::Result<T, JobError>;
pub(crate) const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_DRAFTS: i64 = 50;
const PARAM_PAGE_BYTES: usize = 12 * 1024;
const PARAM_VALUE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub scene_id: String,
    pub state_version: u32,
    #[serde(default)]
    pub params: Map<String, Value>,
    #[serde(default)]
    pub properties: Vec<hertz_wallpaper::PropertyDescriptor>,
}

impl Document {
    fn normalize(&mut self) -> Result<String> {
        // Check bytes before normalizing too: invalid input cannot bypass the cap
        // by having a later typed operation replace one large field.
        bounded_json(self)?;
        self.title = self.title.trim().to_owned();
        if self.title.is_empty()
            || self.title.chars().count() > 120
            || self.title.chars().any(char::is_control)
            || self.description.chars().count() > 4000
        {
            return Err(JobError::invalid_input(
                "作品标题需为 1–120 字符，描述最多 4000 字符",
            ));
        }
        super::config::normalize_builtin(&self.scene_id, self.state_version, &mut self.params)
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
        for value in self.params.values() {
            if serde_json::to_vec(value).map_err(invalid)?.len() > PARAM_VALUE_BYTES {
                return Err(JobError::invalid_input("单个场景参数超过 8 KiB 分页上限"));
            }
        }
        hertz_wallpaper::properties::validate_properties(
            &self.manifest("00000000-0000-4000-8000-000000000000", 1)?,
        )
        .map_err(invalid)?;
        for property in &self.properties {
            if serde_json::to_vec(property).map_err(invalid)?.len() > PARAM_VALUE_BYTES {
                return Err(JobError::invalid_input("单个公开属性超过 8 KiB 分页上限"));
            }
        }
        self.properties
            .sort_by(|left, right| left.id.cmp(&right.id));
        bounded_json(self)
    }

    fn manifest(&self, work_id: &str, version: u32) -> Result<hertz_wallpaper::Manifest> {
        Ok(hertz_wallpaper::Manifest {
            format_version: 1,
            work_id: work_id.to_owned(),
            version,
            title: self.title.clone(),
            description: self.description.clone(),
            content: hertz_wallpaper::Content::Builtin {
                scene_id: self.scene_id.clone(),
                state_version: self.state_version,
                params: self.params.clone(),
            },
            assets: vec![],
            files: vec![],
            properties: self
                .properties
                .iter()
                .map(|property| property.to_map())
                .collect::<std::result::Result<_, _>>()
                .map_err(invalid)?,
            permissions: hertz_wallpaper::Permissions {
                audio_spectrum: false,
                pointer: false,
            },
            license: hertz_wallpaper::License {
                code: "none".into(),
                assets: "none".into(),
                attribution: String::new(),
            },
        })
    }

    pub(crate) fn effective_builtin(&self) -> Result<super::config::BuiltinState> {
        let content = hertz_wallpaper::properties::effective_content(
            &self.manifest("00000000-0000-4000-8000-000000000000", 1)?,
            &Map::new(),
        )
        .map_err(invalid)?;
        let hertz_wallpaper::Content::Builtin {
            scene_id,
            state_version,
            params,
        } = content
        else {
            return Err(JobError::invalid_input("作品草稿不是内置场景"));
        };
        Ok(super::config::BuiltinState {
            scene_id,
            state_version,
            params,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Update {
    ReplaceMetadata {
        title: String,
        description: String,
    },
    ReplaceBuiltin {
        scene_id: String,
        state_version: u32,
        params: Map<String, Value>,
    },
    SetParam {
        id: String,
        value: Value,
    },
    RemoveParam {
        id: String,
    },
    SetProperty {
        property: hertz_wallpaper::PropertyDescriptor,
    },
    RemoveProperty {
        id: String,
    },
}

/// Native-only full state. IPC callers serialize receipt()/parameters(), never
/// an entire potentially 1 MiB document through the management response channel.
#[derive(Debug, Clone)]
pub(crate) struct Draft {
    pub id: String,
    pub revision: u64,
    pub saved_revision: Option<u64>,
    pub work_key: String,
    pub document: Document,
    work_id: String,
    committed_document: Option<Document>,
    published_revision: Option<u64>,
    version: Option<u32>,
    package_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt<'a> {
    pub kind: &'static str,
    pub draft_id: &'a str,
    pub draft_revision: u64,
    pub saved_revision: Option<u64>,
    pub work_key: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub scene_id: &'a str,
    pub state_version: u32,
    pub param_count: usize,
    pub property_count: usize,
    pub version: Option<u32>,
    pub package_hash: Option<&'a str>,
}

impl Draft {
    pub(crate) fn receipt(&self) -> Receipt<'_> {
        Receipt {
            kind: "work",
            draft_id: &self.id,
            draft_revision: self.revision,
            saved_revision: self.saved_revision,
            work_key: &self.work_key,
            title: &self.document.title,
            description: &self.document.description,
            scene_id: &self.document.scene_id,
            state_version: self.document.state_version,
            param_count: self.document.params.len(),
            property_count: self.document.properties.len(),
            version: self.version,
            package_hash: self.package_hash.as_deref(),
        }
    }

    fn check_revision(&self, revision: u64) -> Result<()> {
        if self.revision != revision {
            return Err(conflict());
        }
        Ok(())
    }

    fn published(&self) -> Option<Published> {
        if self.published_revision != Some(self.revision) {
            return None;
        }
        Some(Published {
            draft_id: self.id.clone(),
            draft_revision: self.revision,
            work_key: self.work_key.clone(),
            version: self.version?,
            package_hash: self.package_hash.clone()?,
        })
    }
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub draft_id: String,
    pub draft_revision: i64,
    pub saved_revision: Option<i64>,
    pub work_key: String,
    pub title: String,
    pub scene_id: String,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftPage {
    pub drafts: Vec<Summary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParamPage {
    pub params: Map<String, Value>,
    pub next_cursor: Option<String>,
    pub draft_revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PropertyPage {
    pub properties: Vec<hertz_wallpaper::PropertyDescriptor>,
    pub next_cursor: Option<String>,
    pub draft_revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Published {
    pub draft_id: String,
    pub draft_revision: u64,
    pub work_key: String,
    pub version: u32,
    pub package_hash: String,
}

#[derive(FromRow)]
struct Stored {
    draft_id: String,
    work_key: String,
    work_id: String,
    revision: i64,
    document_json: String,
    committed_revision: Option<i64>,
    committed_document_json: Option<String>,
    published_revision: Option<i64>,
    published_version: Option<i64>,
    published_package_hash: Option<String>,
}

#[derive(FromRow)]
struct Publication {
    draft_id: String,
    draft_revision: i64,
    work_key: String,
    work_id: String,
    version: i64,
    package_hash: String,
    manifest_json: String,
    package_bytes: i64,
}

impl Stored {
    fn decode(self) -> Result<Draft> {
        fn document(json: &str) -> Result<Document> {
            if json.len() > MAX_DOCUMENT_BYTES {
                return Err(JobError::database("作品草稿超过 1 MiB"));
            }
            let mut document: Document = serde_json::from_str(json).map_err(database)?;
            document.normalize().map_err(database)?;
            Ok(document)
        }
        Ok(Draft {
            id: self.draft_id,
            revision: u64::try_from(self.revision).map_err(database)?,
            saved_revision: self
                .committed_revision
                .map(u64::try_from)
                .transpose()
                .map_err(database)?,
            work_key: self.work_key,
            document: document(&self.document_json)?,
            work_id: self.work_id,
            committed_document: self
                .committed_document_json
                .as_deref()
                .map(document)
                .transpose()?,
            published_revision: self
                .published_revision
                .map(u64::try_from)
                .transpose()
                .map_err(database)?,
            version: self
                .published_version
                .map(u32::try_from)
                .transpose()
                .map_err(database)?,
            package_hash: self.published_package_hash,
        })
    }
}

pub(crate) struct WorkDrafts<'a> {
    library: &'a Library,
}

impl<'a> WorkDrafts<'a> {
    pub(crate) fn new(library: &'a Library) -> Self {
        Self { library }
    }

    pub(crate) async fn create(&self, document: Document) -> Result<Draft> {
        let mut token = super::file_tokens::random_token()?;
        token.replace_range(12..13, "4");
        token.replace_range(16..17, "8");
        let work_id = format!(
            "{}-{}-{}-{}-{}",
            &token[..8],
            &token[8..12],
            &token[12..16],
            &token[16..20],
            &token[20..]
        );
        self.insert(document, format!("local-{work_id}"), work_id, None)
            .await
    }

    /// Only the user's local builtin work can be reopened. Import sources and
    /// asset-bearing packages require a future explicit licensed fork contract.
    pub(crate) async fn create_from_version(
        &self,
        work_key: &str,
        package_hash: &str,
    ) -> Result<Draft> {
        if !self
            .library
            .contains_version(work_key, package_hash)
            .await?
        {
            return Err(JobError::new("version_not_found", "作品版本尚未安装"));
        }
        let work = self
            .library
            .get_work(work_key)
            .await?
            .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))?;
        let authored: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM authored_versions a JOIN versions v ON v.version_key=a.version_key WHERE v.work_key=?1 AND v.package_hash=?2)")
            .bind(work_key).bind(package_hash).fetch_one(self.library.pool()).await.map_err(database)?;
        if work.source_id != "local" || work.kind != "builtin" || !authored {
            return Err(JobError::new(
                "work_not_editable",
                "仅可重开本机内置场景作品",
            ));
        }
        let manifest = self.library.cover_manifest(work_key, package_hash).await?;
        if work.remote_work_id.as_deref() != Some(manifest.work_id.as_str())
            || !manifest.files.is_empty()
            || !manifest.assets.is_empty()
        {
            return Err(JobError::new(
                "work_not_editable",
                "当前编辑器不支持此作品的资源",
            ));
        }
        let properties =
            hertz_wallpaper::properties::validate_properties(&manifest).map_err(invalid)?;
        let hertz_wallpaper::Content::Builtin {
            scene_id,
            state_version,
            params,
        } = manifest.content
        else {
            return Err(JobError::new(
                "work_not_editable",
                "当前编辑器仅支持内置场景作品",
            ));
        };
        self.insert(
            Document {
                title: manifest.title,
                description: manifest.description,
                scene_id,
                state_version,
                params,
                properties,
            },
            work_key.to_owned(),
            manifest.work_id,
            Some(package_hash),
        )
        .await
    }

    async fn insert(
        &self,
        mut document: Document,
        work_key: String,
        work_id: String,
        base: Option<&str>,
    ) -> Result<Draft> {
        let json = document.normalize()?;
        let id = format!("work-{}", super::file_tokens::random_token()?);
        let mut tx = self
            .library
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drafts")
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
        if count >= MAX_DRAFTS {
            return Err(JobError::new(
                "draft_limit",
                "最多保留 50 个作品草稿，请先明确丢弃不需要的草稿",
            ));
        }
        // Recheck the pinned base inside the write transaction. A deletion that
        // won the race must not be followed by an unprotected dangling draft.
        if let Some(hash) = base {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash WHERE v.work_key=?1 AND v.package_hash=?2 AND p.state='installed')")
                .bind(&work_key).bind(hash).fetch_one(&mut *tx).await.map_err(database)?;
            if !exists {
                return Err(JobError::new("version_not_found", "作品版本已被移除"));
            }
        }
        sqlx::query("INSERT INTO drafts(draft_id,work_key,work_id,revision,document_json,base_package_hash,created_at,updated_at) VALUES(?1,?2,?3,1,?4,?5,?6,?6)")
            .bind(&id).bind(&work_key).bind(&work_id).bind(json).bind(base).bind(now_secs())
            .execute(&mut *tx).await.map_err(database)?;
        tx.commit().await.map_err(database)?;
        self.get(&id).await
    }

    pub(crate) async fn get(&self, id: &str) -> Result<Draft> {
        validate_id(id)?;
        sqlx::query_as::<_, Stored>("SELECT draft_id,work_key,work_id,revision,document_json,committed_revision,committed_document_json,published_revision,published_version,published_package_hash FROM drafts WHERE draft_id=?1")
            .bind(id).fetch_optional(self.library.pool()).await.map_err(database)?
            .ok_or_else(not_found)?.decode()
    }

    pub(crate) async fn list(&self, limit: u32, cursor: Option<&str>) -> Result<DraftPage> {
        if let Some(cursor) = cursor {
            validate_id(cursor)?;
        }
        let limit = limit.clamp(1, 20) as usize;
        let mut drafts: Vec<Summary> = sqlx::query_as("SELECT draft_id,revision AS draft_revision,committed_revision AS saved_revision,work_key,json_extract(document_json,'$.title') AS title,json_extract(document_json,'$.sceneId') AS scene_id,updated_at FROM drafts WHERE (?1 IS NULL OR draft_id>?1) ORDER BY draft_id LIMIT ?2")
            .bind(cursor).bind((limit + 1) as i64).fetch_all(self.library.pool()).await.map_err(database)?;
        let next_cursor = if drafts.len() > limit {
            drafts.truncate(limit);
            drafts.last().map(|row| row.draft_id.clone())
        } else {
            None
        };
        Ok(DraftPage {
            drafts,
            next_cursor,
        })
    }

    pub(crate) async fn parameters(
        &self,
        id: &str,
        revision: u64,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<ParamPage> {
        let draft = self.get(id).await?;
        draft.check_revision(revision)?;
        if cursor.is_some_and(|key| !draft.document.params.contains_key(key)) {
            return Err(JobError::invalid_input("参数游标不属于当前草稿"));
        }
        let mut page = ParamPage {
            params: Map::new(),
            next_cursor: None,
            draft_revision: revision,
        };
        let limit = limit.clamp(1, 32) as usize;
        // serde_json::Map may use insertion order in another workspace feature
        // set; sort explicitly so a cursor never skips keys.
        let mut entries: Vec<_> = draft.document.params.into_iter().collect();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        for (key, value) in entries {
            if cursor.is_some_and(|cursor| key.as_str() <= cursor) {
                continue;
            }
            if page.params.len() == limit {
                page.next_cursor = page.params.keys().max().cloned();
                break;
            }
            page.params.insert(key.clone(), value);
            if serde_json::to_vec(&page).map_err(invalid)?.len() > PARAM_PAGE_BYTES - 256 {
                page.params.remove(&key);
                page.next_cursor = page.params.keys().max().cloned();
                if page.params.is_empty() {
                    return Err(JobError::invalid_input("单个场景参数超过分页上限"));
                }
                break;
            }
        }
        Ok(page)
    }

    pub(crate) async fn properties(
        &self,
        id: &str,
        revision: u64,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<PropertyPage> {
        let draft = self.get(id).await?;
        draft.check_revision(revision)?;
        if cursor.is_some_and(|key| {
            !draft
                .document
                .properties
                .iter()
                .any(|property| property.id == key)
        }) {
            return Err(JobError::invalid_input("公开属性游标不属于当前草稿"));
        }
        let mut page = PropertyPage {
            properties: vec![],
            next_cursor: None,
            draft_revision: revision,
        };
        let limit = limit.clamp(1, 32) as usize;
        // Stored documents normalize property IDs into stable cursor order.
        for property in draft.document.properties {
            if cursor.is_some_and(|cursor| property.id.as_str() <= cursor) {
                continue;
            }
            if page.properties.len() == limit {
                page.next_cursor = page.properties.last().map(|property| property.id.clone());
                break;
            }
            page.properties.push(property);
            if serde_json::to_vec(&page).map_err(invalid)?.len() > PARAM_PAGE_BYTES - 256 {
                page.properties.pop();
                page.next_cursor = page.properties.last().map(|property| property.id.clone());
                if page.properties.is_empty() {
                    return Err(JobError::invalid_input("单个公开属性超过分页上限"));
                }
                break;
            }
        }
        Ok(page)
    }

    pub(crate) async fn update(
        &self,
        id: &str,
        revision: u64,
        operations: Vec<Update>,
    ) -> Result<Draft> {
        if operations.is_empty() || operations.len() > 32 {
            return Err(JobError::invalid_input("每次需提供 1–32 个类型化修改"));
        }
        let mut draft = self.get(id).await?;
        draft.check_revision(revision)?;
        self.check_not_publishing(id).await?;
        for operation in operations {
            match operation {
                Update::ReplaceMetadata { title, description } => {
                    draft.document.title = title;
                    draft.document.description = description;
                }
                Update::ReplaceBuiltin {
                    scene_id,
                    state_version,
                    params,
                } => {
                    draft.document.scene_id = scene_id;
                    draft.document.state_version = state_version;
                    draft.document.params = params;
                }
                Update::SetParam { id, value } => {
                    draft.document.params.insert(id, value);
                }
                Update::RemoveParam { id } => {
                    if draft.document.params.remove(&id).is_none() {
                        return Err(JobError::invalid_input("不能移除未知场景参数"));
                    }
                }
                Update::SetProperty { property } => {
                    if let Some(existing) = draft
                        .document
                        .properties
                        .iter_mut()
                        .find(|existing| existing.id == property.id)
                    {
                        *existing = property;
                    } else {
                        draft.document.properties.push(property);
                    }
                }
                Update::RemoveProperty { id } => {
                    let Some(index) = draft
                        .document
                        .properties
                        .iter()
                        .position(|property| property.id == id)
                    else {
                        return Err(JobError::invalid_input("不能移除未知公开属性"));
                    };
                    draft.document.properties.remove(index);
                }
            }
            // Every typed operation must be valid. Normalization restores the
            // registry default for RemoveParam instead of inventing a fallback.
            draft.document.normalize()?;
        }
        let json = draft.document.normalize()?;
        if revision >= i64::MAX as u64 {
            return Err(conflict());
        }
        let changed = sqlx::query("UPDATE drafts SET document_json=?1,revision=revision+1,updated_at=?2 WHERE draft_id=?3 AND revision=?4 AND NOT EXISTS(SELECT 1 FROM draft_publications WHERE draft_id=?3)")
            .bind(json).bind(now_secs()).bind(id).bind(revision as i64)
            .execute(self.library.pool()).await.map_err(database)?.rows_affected();
        if changed != 1 {
            self.check_not_publishing(id).await?;
            return Err(conflict());
        }
        draft.revision += 1;
        Ok(draft)
    }

    /// Commit the current project snapshot only. It neither creates a library
    /// work/version nor changes the desktop selection or configuration revision.
    pub(crate) async fn save(&self, id: &str, revision: u64) -> Result<Draft> {
        let mut draft = self.get(id).await?;
        draft.check_revision(revision)?;
        self.check_not_publishing(id).await?;
        let json = draft.document.normalize()?;
        let changed = sqlx::query("UPDATE drafts SET committed_revision=revision,committed_document_json=?1,updated_at=?2 WHERE draft_id=?3 AND revision=?4 AND NOT EXISTS(SELECT 1 FROM draft_publications WHERE draft_id=?3)")
            .bind(json).bind(now_secs()).bind(id).bind(as_revision(revision)?)
            .execute(self.library.pool()).await.map_err(database)?.rows_affected();
        if changed != 1 {
            self.check_not_publishing(id).await?;
            return Err(conflict());
        }
        draft.saved_revision = Some(revision);
        draft.committed_document = Some(draft.document.clone());
        Ok(draft)
    }

    pub(crate) async fn discard(&self, id: &str, revision: u64) -> Result<()> {
        let draft = self.get(id).await?;
        draft.check_revision(revision)?;
        self.check_not_publishing(id).await?;
        let changed = sqlx::query("DELETE FROM drafts WHERE draft_id=?1 AND revision=?2 AND NOT EXISTS(SELECT 1 FROM draft_publications WHERE draft_id=?1)")
            .bind(id)
            .bind(as_revision(revision)?)
            .execute(self.library.pool())
            .await
            .map_err(database)?
            .rows_affected();
        if changed != 1 {
            self.check_not_publishing(id).await?;
            return Err(conflict());
        }
        Ok(())
    }

    async fn check_not_publishing(&self, id: &str) -> Result<()> {
        let pending: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM draft_publications WHERE draft_id=?1)")
                .bind(id)
                .fetch_one(self.library.pool())
                .await
                .map_err(database)?;
        if pending {
            return Err(JobError::new(
                "draft_busy",
                "作品版本生成尚未完成，请重试生成版本后再编辑或丢弃",
            ));
        }
        Ok(())
    }

    /// Call while holding the same content writer used for deletion. Persistent
    /// drafts pin their base and newest generated version across app restarts.
    #[cfg(test)]
    pub(crate) async fn references(
        &self,
        work_key: &str,
        package_hash: Option<&str>,
    ) -> Result<bool> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM drafts WHERE work_key=?1 AND (?2 IS NULL OR base_package_hash=?2 OR published_package_hash=?2)) OR EXISTS(SELECT 1 FROM draft_publications WHERE work_key=?1 AND (?2 IS NULL OR package_hash=?2))")
            .bind(work_key).bind(package_hash).fetch_one(self.library.pool()).await.map_err(database)
    }

    /// Publish an explicitly saved revision using AssetStore's existing content
    /// gate, quota, validation and atomic directory publication. The final SQL
    /// transaction records the package/version and idempotent receipt together.
    pub(crate) async fn publish(
        &self,
        id: &str,
        revision: u64,
        assets: &AssetStore,
    ) -> Result<Published> {
        let writer = assets.content_writer()?;
        let draft = self.get(id).await?;
        draft.check_revision(revision)?;
        if draft.saved_revision != Some(revision) {
            return Err(JobError::new(
                "draft_not_saved",
                "请先保存当前作品修改，再生成版本",
            ));
        }
        if let Some(published) = draft.published() {
            return Ok(published);
        }
        let document = draft
            .committed_document
            .as_ref()
            .ok_or_else(|| JobError::database("已保存工程缺失"))?;
        // This durable request precedes all filesystem publication. A restart
        // may index the directory as an ordinary import; retries still use the
        // original version/hash and never infer authorship from workId alone.
        let (publication, bytes) = self.reserve_publication(&draft).await?;
        let version = publication.version as u32;
        let job_id = format!("work-{}", super::file_tokens::random_token()?);
        let staging = assets.staging_dir(&job_id);
        let outcome = async {
            assets.check_disk_space(bytes.len() as u64 + 4096)?;
            std::fs::create_dir(&staging).map_err(io)?;
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
                .open(staging.join("original.hwpkg")).map_err(io)?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(io)?;
            drop(file);
            let package = assets.validate_staged(&job_id)?;
            writer.preflight(&job_id, &package)?;
            assets.unpack_projection(&job_id, &package)?;
            match writer.publish_staging(&job_id, &package.package_hash) {
                Ok(()) => {}
                Err(error) if error.code == "target_exists" => {
                    if assets.verify_installed(&package.package_hash)?.is_none() { return Err(error); }
                }
                Err(error) => return Err(error),
            }
            #[cfg(test)]
            if std::env::var_os("HERTZ_WORK_DRAFT_TEST_CRASH_AFTER_PUBLISH")
                .is_some_and(|path| std::path::Path::new(&path) == assets.root())
            {
                // The child-process regression exits at the actual production
                // rename/commit boundary, without cleanup or a mock recovery.
                std::process::exit(86);
            }
            let mut tx = self.library.pool().begin_with("BEGIN IMMEDIATE").await.map_err(database)?;
            let current: Option<(i64, Option<i64>, Option<i64>)> = sqlx::query_as("SELECT revision,committed_revision,published_revision FROM drafts WHERE draft_id=?1")
                .bind(id).fetch_optional(&mut *tx).await.map_err(database)?;
            if current != Some((revision as i64, Some(revision as i64), draft.published_revision.map(|value| value as i64))) {
                return Err(conflict());
            }
            let matches_intent: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM draft_publications WHERE draft_id=?1 AND draft_revision=?2 AND work_key=?3 AND work_id=?4 AND version=?5 AND package_hash=?6 AND manifest_json=?7 AND package_bytes=?8)")
                .bind(id).bind(revision as i64).bind(&draft.work_key).bind(&draft.work_id)
                .bind(publication.version).bind(&package.package_hash).bind(&package.manifest_json).bind(bytes.len() as i64)
                .fetch_one(&mut *tx).await.map_err(database)?;
            if !matches_intent { return Err(conflict()); }
            let existing_version: Option<String> = sqlx::query_scalar("SELECT package_hash FROM versions WHERE work_key=?1 AND version=?2")
                .bind(&draft.work_key).bind(publication.version).fetch_optional(&mut *tx).await.map_err(database)?;
            if existing_version.as_ref().is_some_and(|hash| hash != &publication.package_hash) {
                return Err(JobError::hash_conflict("发布意图的版本已绑定其它包，不能覆盖"));
            }
            let existing: Option<(String, Option<String>, String)> = sqlx::query_as("SELECT source_id,remote_work_id,kind FROM works WHERE work_key=?1")
                .bind(&draft.work_key).fetch_optional(&mut *tx).await.map_err(database)?;
            if existing.as_ref().is_some_and(|(source, work_id, kind)| source != "local" || work_id.as_deref() != Some(draft.work_id.as_str()) || kind != "builtin") {
                return Err(JobError::new("work_not_editable", "本机作品身份已变化"));
            }
            if existing.is_some() {
                let authored: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM authored_versions a JOIN versions v ON v.version_key=a.version_key WHERE v.work_key=?1)")
                    .bind(&draft.work_key).fetch_one(&mut *tx).await.map_err(database)?;
                // A verified exact intent may finish its own orphan recovered
                // by the ordinary import reconciler. No other imported version
                // or matching logical UUID grants this exception.
                if !authored && existing_version.as_deref() != Some(publication.package_hash.as_str()) {
                    return Err(JobError::new("work_not_editable", "不能覆盖导入的第三方作品"));
                }
            }
            let now = now_secs();
            sqlx::query("INSERT INTO packages(package_hash,manifest_json,installed_at,bytes,state) VALUES(?1,?2,?3,?4,'installed') ON CONFLICT(package_hash) DO NOTHING")
                .bind(&package.package_hash).bind(&package.manifest_json).bind(now).bind(bytes.len() as i64)
                .execute(&mut *tx).await.map_err(database)?;
            let existing_package: (String, i64, String) = sqlx::query_as("SELECT manifest_json,bytes,state FROM packages WHERE package_hash=?1")
                .bind(&package.package_hash).fetch_one(&mut *tx).await.map_err(database)?;
            if existing_package.0 != package.manifest_json || existing_package.1 != bytes.len() as i64 || existing_package.2 == "quarantined" {
                return Err(JobError::hash_conflict("包身份已绑定其它内容或被隔离"));
            }
            sqlx::query("UPDATE packages SET state='installed' WHERE package_hash=?1")
                .bind(&package.package_hash).execute(&mut *tx).await.map_err(database)?;
            sqlx::query("INSERT INTO works(work_key,source_id,remote_work_id,title,description,kind,created_at,updated_at) VALUES(?1,'local',?2,?3,?4,'builtin',?5,?5) ON CONFLICT(work_key) DO UPDATE SET title=excluded.title,description=excluded.description,updated_at=excluded.updated_at")
                .bind(&draft.work_key).bind(&draft.work_id).bind(&document.title).bind(&document.description).bind(now)
                .execute(&mut *tx).await.map_err(database)?;
            sqlx::query("INSERT INTO versions(version_key,work_key,version,package_hash,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(work_key,version) DO NOTHING")
                .bind(format!("{}@{version}", draft.work_key)).bind(&draft.work_key).bind(i64::from(version)).bind(&package.package_hash).bind(now)
                .execute(&mut *tx).await.map_err(database)?;
            sqlx::query("INSERT INTO authored_versions(version_key) VALUES(?1) ON CONFLICT(version_key) DO NOTHING")
                .bind(format!("{}@{version}", draft.work_key)).execute(&mut *tx).await.map_err(database)?;
            sqlx::query("UPDATE drafts SET published_revision=?1,published_version=?2,published_package_hash=?3,updated_at=?4 WHERE draft_id=?5")
                .bind(revision as i64).bind(i64::from(version)).bind(&package.package_hash).bind(now).bind(id)
                .execute(&mut *tx).await.map_err(database)?;
            sqlx::query("DELETE FROM draft_publications WHERE draft_id=?1")
                .bind(id).execute(&mut *tx).await.map_err(database)?;
            tx.commit().await.map_err(database)?;
            Ok(Published { draft_id: id.to_owned(), draft_revision: revision, work_key: draft.work_key.clone(), version, package_hash: package.package_hash })
        }.await;
        assets.cleanup_staging(&job_id);
        // Pre-publication failures (for example quota rejection) need no crash
        // receipt and must leave the saved draft editable. Once the directory
        // exists its intent stays until an explicit retry completes it.
        if outcome.is_err()
            && matches!(
                assets.package_dir(&publication.package_hash).try_exists(),
                Ok(false)
            )
        {
            sqlx::query("DELETE FROM draft_publications WHERE draft_id=?1 AND draft_revision=?2 AND package_hash=?3")
                .bind(id).bind(revision as i64).bind(&publication.package_hash)
                .execute(self.library.pool()).await.map_err(database)?;
        }
        outcome
    }

    async fn reserve_publication(&self, draft: &Draft) -> Result<(Publication, Vec<u8>)> {
        let mut tx = self
            .library
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let current: Option<(i64, Option<i64>)> =
            sqlx::query_as("SELECT revision,committed_revision FROM drafts WHERE draft_id=?1")
                .bind(&draft.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(database)?;
        if current != Some((draft.revision as i64, Some(draft.revision as i64))) {
            return Err(conflict());
        }
        let existing: Option<Publication> = sqlx::query_as("SELECT draft_id,draft_revision,work_key,work_id,version,package_hash,manifest_json,package_bytes FROM draft_publications WHERE draft_id=?1")
            .bind(&draft.id).fetch_optional(&mut *tx).await.map_err(database)?;
        let version = if let Some(publication) = &existing {
            publication.version
        } else {
            let pending: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM draft_publications WHERE work_key=?1)",
            )
            .bind(&draft.work_key)
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
            if pending {
                return Err(JobError::new(
                    "draft_busy",
                    "该作品另一份草稿的版本生成尚未完成，请先重试原发布",
                ));
            }
            let max_installed: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version),0) FROM versions WHERE work_key=?1",
            )
            .bind(&draft.work_key)
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
            max_installed
                .checked_add(1)
                .ok_or_else(|| JobError::new("version_limit", "作品版本已达到上限"))?
        };
        let version_u32 = u32::try_from(version)
            .map_err(|_| JobError::new("version_limit", "作品版本已达到上限"))?;
        let document = draft
            .committed_document
            .as_ref()
            .ok_or_else(|| JobError::database("已保存工程缺失"))?;
        let bytes = builtin_package(document, &draft.work_id, version_u32)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let manifest = hertz_wallpaper::validate_package(Cursor::new(&bytes))?.manifest;
        let manifest_json = serde_json::to_string(&manifest).map_err(invalid)?;
        let publication = if let Some(publication) = existing {
            if publication.draft_id != draft.id
                || publication.draft_revision != draft.revision as i64
                || publication.work_key != draft.work_key
                || publication.work_id != draft.work_id
                || publication.package_hash != hash
                || publication.manifest_json != manifest_json
                || publication.package_bytes != bytes.len() as i64
            {
                return Err(JobError::new(
                    "publication_conflict",
                    "原生发布意图与已保存工程不匹配，未重新分配版本",
                ));
            }
            publication
        } else {
            sqlx::query("INSERT INTO draft_publications(draft_id,draft_revision,work_key,work_id,version,package_hash,manifest_json,package_bytes,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")
                .bind(&draft.id).bind(draft.revision as i64).bind(&draft.work_key).bind(&draft.work_id)
                .bind(version).bind(&hash).bind(&manifest_json).bind(bytes.len() as i64).bind(now_secs())
                .execute(&mut *tx).await.map_err(database)?;
            Publication {
                draft_id: draft.id.clone(),
                draft_revision: draft.revision as i64,
                work_key: draft.work_key.clone(),
                work_id: draft.work_id.clone(),
                version,
                package_hash: hash,
                manifest_json,
                package_bytes: bytes.len() as i64,
            }
        };
        tx.commit().await.map_err(database)?;
        Ok((publication, bytes))
    }
}

/// Deterministic native package construction from a committed builtin document.
/// No wall-clock ZIP fields or generated permissions enter the immutable bytes.
pub(crate) fn builtin_package(document: &Document, work_id: &str, version: u32) -> Result<Vec<u8>> {
    let mut document = document.clone();
    document.normalize()?;
    let manifest = document.manifest(work_id, version)?;
    let json = serde_json::to_vec(&manifest).map_err(invalid)?;
    hertz_wallpaper::validate_manifest_bytes(&json)?;
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default());
    archive.start_file("manifest.json", options).map_err(io)?;
    archive.write_all(&json).map_err(io)?;
    let bytes = archive.finish().map_err(io)?.into_inner();
    hertz_wallpaper::validate_package(Cursor::new(&bytes))?;
    Ok(bytes)
}

fn bounded_json(document: &Document) -> Result<String> {
    let json = serde_json::to_string(document).map_err(invalid)?;
    if json.len() > MAX_DOCUMENT_BYTES {
        return Err(JobError::invalid_input("作品草稿超过 1 MiB"));
    }
    Ok(json)
}
fn validate_id(id: &str) -> Result<()> {
    if id.len() != 37
        || !id.starts_with("work-")
        || !id[5..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(JobError::invalid_input("作品草稿 id 无效"));
    }
    Ok(())
}
fn as_revision(revision: u64) -> Result<i64> {
    i64::try_from(revision).map_err(|_| conflict())
}
fn conflict() -> JobError {
    JobError::new("draft_conflict", "草稿修订已变化，未覆盖现有修改")
}
fn not_found() -> JobError {
    JobError::new("draft_not_found", "作品草稿不存在或已被丢弃")
}
fn invalid(error: impl std::fmt::Display) -> JobError {
    JobError::invalid_input(error.to_string())
}
fn database(error: impl std::fmt::Display) -> JobError {
    JobError::database(error.to_string())
}
fn io(error: impl std::fmt::Display) -> JobError {
    JobError::io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::library::tempfileish;
    use super::*;
    use serde_json::json;

    fn document() -> Document {
        Document {
            title: "海岸练习".into(),
            description: "本机作品".into(),
            scene_id: "coast".into(),
            state_version: 1,
            params: Map::new(),
            properties: vec![],
        }
    }

    fn title(title: &str) -> Update {
        Update::ReplaceMetadata {
            title: title.into(),
            description: "本机作品".into(),
        }
    }

    fn property(param: &str, id: &str, value: Value) -> hertz_wallpaper::PropertyDescriptor {
        hertz_wallpaper::properties::builtin_property("coast", 1, param, id, "公开参数", value)
            .unwrap()
    }

    #[tokio::test]
    async fn public_properties_survive_save_publish_restart_and_authored_reopen() {
        let root = tempfileish::temp_dir("work-properties-roundtrip");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        let property = property("tod", "day-time", json!(0.65));
        let edited = drafts
            .update(
                &draft.id,
                1,
                vec![Update::SetProperty {
                    property: property.clone(),
                }],
            )
            .await
            .unwrap();
        assert_eq!(edited.document.params["tod"], json!(0));
        assert_eq!(
            edited.document.effective_builtin().unwrap().params["tod"],
            json!(0.65)
        );
        drafts.save(&draft.id, edited.revision).await.unwrap();
        let published = drafts
            .publish(&draft.id, edited.revision, &assets)
            .await
            .unwrap();
        let package_path = assets
            .package_dir(&published.package_hash)
            .join("original.hwpkg");
        let original = std::fs::read(&package_path).unwrap();
        let package = hertz_wallpaper::validate_package(Cursor::new(&original)).unwrap();
        assert_eq!(
            hertz_wallpaper::properties::validate_properties(&package.manifest).unwrap(),
            vec![property.clone()]
        );
        library.pool().close().await;
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let restored = drafts.get(&draft.id).await.unwrap();
        assert_eq!(restored.document.properties, vec![property.clone()]);
        assert_eq!(restored.saved_revision, Some(edited.revision));
        let reopened = drafts
            .create_from_version(&published.work_key, &published.package_hash)
            .await
            .unwrap();
        assert_eq!(reopened.document.properties, vec![property]);
        assert_eq!(
            reopened.document.effective_builtin().unwrap().params["tod"],
            json!(0.65)
        );
        let removed = drafts
            .update(
                &reopened.id,
                1,
                vec![Update::RemoveProperty {
                    id: "day-time".into(),
                }],
            )
            .await
            .unwrap();
        assert!(removed.document.properties.is_empty());
        assert_eq!(std::fs::read(package_path).unwrap(), original);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn public_property_updates_are_atomic_typed_and_revision_bound() {
        let root = tempfileish::temp_dir("work-properties-strict");
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        let valid = property("discRing", "disc-ring", json!(true));
        let edited = drafts
            .update(
                &draft.id,
                1,
                vec![Update::SetProperty {
                    property: valid.clone(),
                }],
            )
            .await
            .unwrap();
        let mut invalid = valid.clone();
        invalid.default = json!("true");
        assert!(drafts
            .update(
                &draft.id,
                2,
                vec![title("不可写入"), Update::SetProperty { property: invalid }]
            )
            .await
            .is_err());
        let mut duplicate = valid.clone();
        duplicate.id = "another-id".into();
        assert!(drafts
            .update(
                &draft.id,
                2,
                vec![Update::SetProperty {
                    property: duplicate
                }]
            )
            .await
            .is_err());
        assert!(drafts
            .update(
                &draft.id,
                2,
                vec![Update::RemoveProperty {
                    id: "missing".into()
                }]
            )
            .await
            .is_err());
        assert_eq!(
            drafts
                .update(&draft.id, 1, vec![Update::RemoveProperty { id: valid.id }])
                .await
                .unwrap_err()
                .code,
            "draft_conflict"
        );
        assert_eq!(
            drafts.get(&draft.id).await.unwrap().document,
            edited.document
        );
        assert_eq!(drafts.get(&draft.id).await.unwrap().revision, 2);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn public_property_pages_are_bounded_ordered_and_reject_stale_cursors() {
        let root = tempfileish::temp_dir("work-properties-pages");
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let mut document = document();
        for (id, spec) in hertz_wallpaper::catalog().scene("coast").unwrap()["params"]
            .as_object()
            .unwrap()
        {
            let property_id = if id == "discRing" { "disc-ring" } else { id };
            document
                .properties
                .push(property(id, property_id, spec["default"].clone()));
        }
        let draft = drafts.create(document).await.unwrap();
        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let page = drafts
                .properties(&draft.id, 1, cursor.as_deref(), 3)
                .await
                .unwrap();
            assert!(page.properties.len() <= 3);
            assert!(serde_json::to_vec(&page).unwrap().len() < PARAM_PAGE_BYTES);
            ids.extend(page.properties.iter().map(|property| property.id.clone()));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            ids,
            draft
                .document
                .properties
                .iter()
                .map(|property| property.id.clone())
                .collect::<Vec<_>>()
        );
        assert!(drafts
            .properties(&draft.id, 1, Some("not-a-property"), 3)
            .await
            .is_err());
        drafts
            .update(&draft.id, 1, vec![title("下一修订")])
            .await
            .unwrap();
        assert_eq!(
            drafts
                .properties(&draft.id, 1, None, 3)
                .await
                .unwrap_err()
                .code,
            "draft_conflict"
        );
        library.pool().close().await;
    }

    async fn count(library: &Library, table: &str) -> i64 {
        // Table names are compile-time fixture choices, never IPC input.
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(library.pool())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn saved_and_unsaved_documents_survive_database_reopen_without_changing_config() {
        let root = tempfileish::temp_dir("work-draft-reopen");
        let config_path = root.path().join("config.json");
        let config_bytes = serde_json::to_vec(&json!({
            "schemaVersion": 5, "revision": 17,
            "wallpaper": crate::config::Config::default().wallpaper
        }))
        .unwrap();
        std::fs::write(&config_path, &config_bytes).unwrap();
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        assert_eq!(draft.revision, 1);
        assert_eq!(draft.saved_revision, None);
        assert!(!draft.document.params.is_empty());
        let saved = drafts.save(&draft.id, 1).await.unwrap();
        assert_eq!(saved.saved_revision, Some(1));
        let edited = drafts
            .update(&draft.id, 1, vec![title("尚未提交的标题")])
            .await
            .unwrap();
        assert_eq!(edited.revision, 2);
        assert_eq!(edited.saved_revision, Some(1));
        assert_eq!(
            count(&library, "works").await,
            0,
            "save commits an engineering document, not a version"
        );
        assert_eq!(count(&library, "packages").await, 0);
        library.pool().close().await;
        let reopened = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&reopened);
        let restored = drafts.get(&draft.id).await.unwrap();
        assert_eq!(restored.document, edited.document);
        assert_eq!(restored.committed_document.unwrap(), saved.document);
        assert_eq!(restored.saved_revision, Some(1));
        assert_eq!(drafts.list(20, None).await.unwrap().drafts.len(), 1);
        let assets = AssetStore::new(root.path()).unwrap();
        assert_eq!(
            drafts
                .publish(&draft.id, 2, &assets)
                .await
                .unwrap_err()
                .code,
            "draft_not_saved"
        );
        drafts.save(&draft.id, 2).await.unwrap();
        drafts.discard(&draft.id, 2).await.unwrap();
        assert_eq!(
            drafts.get(&draft.id).await.unwrap_err().code,
            "draft_not_found"
        );
        assert_eq!(std::fs::read(config_path).unwrap(), config_bytes);
        reopened.pool().close().await;
    }

    #[tokio::test]
    async fn independent_connections_race_on_one_revision_and_old_save_or_discard_cannot_win() {
        let root = tempfileish::temp_dir("work-draft-cas");
        let first = Library::open(root.path()).await.unwrap();
        let second = Library::open(root.path()).await.unwrap();
        let drafts_a = WorkDrafts::new(&first);
        let drafts_b = WorkDrafts::new(&second);
        let draft = drafts_a.create(document()).await.unwrap();
        let (left, right) = tokio::join!(
            drafts_a.update(&draft.id, 1, vec![title("窗口甲")]),
            drafts_b.update(&draft.id, 1, vec![title("窗口乙")])
        );
        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        let (winner, loser) = match left {
            Ok(winner) => (winner, right.unwrap_err()),
            Err(loser) => (right.unwrap(), loser),
        };
        assert_eq!(loser.code, "draft_conflict");
        assert_eq!(
            drafts_a.save(&draft.id, 1).await.unwrap_err().code,
            "draft_conflict"
        );
        assert_eq!(
            drafts_b.discard(&draft.id, 1).await.unwrap_err().code,
            "draft_conflict"
        );
        let current = drafts_b.get(&draft.id).await.unwrap();
        assert_eq!(current.revision, 2);
        assert_eq!(current.document, winner.document);
        first.pool().close().await;
        second.pool().close().await;
    }

    #[tokio::test]
    async fn invalid_batch_limits_and_size_leave_the_previous_document_intact() {
        let root = tempfileish::temp_dir("work-draft-validation");
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        let bad_batches = vec![
            vec![],
            vec![title("批次过长"); 33],
            vec![
                title("不能留下半批修改"),
                Update::SetParam {
                    id: "tod".into(),
                    value: json!(-99),
                },
            ],
            vec![Update::SetParam {
                id: "unknown".into(),
                value: json!(1),
            }],
            vec![Update::ReplaceBuiltin {
                scene_id: "coast".into(),
                state_version: 999,
                params: Map::new(),
            }],
            vec![Update::ReplaceMetadata {
                title: "大草稿".into(),
                description: "x".repeat(MAX_DOCUMENT_BYTES),
            }],
        ];
        for batch in bad_batches {
            assert_eq!(
                drafts.update(&draft.id, 1, batch).await.unwrap_err().code,
                "invalid_input"
            );
            let intact = drafts.get(&draft.id).await.unwrap();
            assert_eq!(intact.revision, 1);
            assert_eq!(intact.document, draft.document);
        }
        assert!(serde_json::from_value::<Update>(
            json!({"kind":"setParam","id":"tod","value":1,"unexpected":true})
        )
        .is_err());
        let changed = drafts
            .update(
                &draft.id,
                1,
                vec![Update::SetParam {
                    id: "tod".into(),
                    value: json!(0.25),
                }],
            )
            .await
            .unwrap();
        let reset = drafts
            .update(
                &draft.id,
                changed.revision,
                vec![Update::RemoveParam { id: "tod".into() }],
            )
            .await
            .unwrap();
        assert_eq!(reset.document.params["tod"], draft.document.params["tod"]);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn saved_versions_are_immutable_idempotent_and_reopen_as_the_same_work() {
        let root = tempfileish::temp_dir("work-draft-versions");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        assert_eq!(first.version, 1);
        let first_path = assets
            .package_dir(&first.package_hash)
            .join("original.hwpkg");
        let original_bytes = std::fs::read(&first_path).unwrap();
        let package = hertz_wallpaper::validate_package(Cursor::new(&original_bytes)).unwrap();
        assert_eq!(package.manifest.title, document().title);
        assert!(package.entries.is_empty());
        assert!(assets
            .verify_installed(&first.package_hash)
            .unwrap()
            .is_some());
        assert_eq!(drafts.publish(&draft.id, 1, &assets).await.unwrap(), first);
        assert_eq!(count(&library, "versions").await, 1);
        let edited = drafts
            .update(
                &draft.id,
                1,
                vec![
                    title("暮色海岸"),
                    Update::SetParam {
                        id: "tod".into(),
                        value: json!(0.25),
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(
            drafts
                .publish(&draft.id, edited.revision, &assets)
                .await
                .unwrap_err()
                .code,
            "draft_not_saved"
        );
        drafts.save(&draft.id, edited.revision).await.unwrap();
        let second = drafts
            .publish(&draft.id, edited.revision, &assets)
            .await
            .unwrap();
        assert_eq!(second.version, 2);
        assert_ne!(first.package_hash, second.package_hash);
        assert_eq!(first.work_key, second.work_key);
        assert_eq!(std::fs::read(&first_path).unwrap(), original_bytes);
        assert_eq!(
            library
                .get_work(&first.work_key)
                .await
                .unwrap()
                .unwrap()
                .title,
            "暮色海岸"
        );
        let newer = library
            .cover_manifest(&second.work_key, &second.package_hash)
            .await
            .unwrap();
        let hertz_wallpaper::Content::Builtin { params, .. } = newer.content else {
            panic!("builtin")
        };
        assert_eq!(params["tod"], json!(0.25));
        let old = drafts
            .create_from_version(&first.work_key, &first.package_hash)
            .await
            .unwrap();
        assert_eq!(
            old.document.title,
            document().title,
            "reopening an old version reads its immutable metadata"
        );
        assert_eq!(old.work_key, first.work_key);
        assert!(drafts
            .references(&first.work_key, Some(&first.package_hash))
            .await
            .unwrap());
        drafts.save(&old.id, 1).await.unwrap();
        let third = drafts.publish(&old.id, 1, &assets).await.unwrap();
        assert_eq!(
            third.version, 3,
            "branches append instead of overwriting a published version"
        );
        assert_eq!(count(&library, "works").await, 1);
        assert_eq!(count(&library, "versions").await, 3);
        library.pool().close().await;
        let reopened = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&reopened);
        assert_eq!(drafts.publish(&old.id, 1, &assets).await.unwrap(), third);
        drafts.discard(&draft.id, edited.revision).await.unwrap();
        drafts.discard(&old.id, 1).await.unwrap();
        assert!(!drafts.references(&first.work_key, None).await.unwrap());
        assert!(reopened
            .contains_version(&first.work_key, &first.package_hash)
            .await
            .unwrap());
        assert_eq!(
            count(&reopened, "versions").await,
            3,
            "discarding drafts never deletes installed versions"
        );
        reopened.pool().close().await;
    }

    #[tokio::test]
    async fn failed_publication_keeps_saved_work_and_does_not_index_a_partial_version() {
        let root = tempfileish::temp_dir("work-draft-full");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path())
            .unwrap()
            .with_content_capacity(1);
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        assert_eq!(
            drafts
                .publish(&draft.id, 1, &assets)
                .await
                .unwrap_err()
                .code,
            "library_full"
        );
        assert_eq!(drafts.get(&draft.id).await.unwrap().saved_revision, Some(1));
        assert_eq!(count(&library, "versions").await, 0);
        assert_eq!(count(&library, "works").await, 0);
        assert_eq!(count(&library, "packages").await, 0);
        assert_eq!(count(&library, "draft_publications").await, 0);
        assert_eq!(
            std::fs::read_dir(root.path().join("staging"))
                .unwrap()
                .count(),
            0
        );
        let assets = AssetStore::new(root.path()).unwrap();
        assert_eq!(
            drafts.publish(&draft.id, 1, &assets).await.unwrap().version,
            1
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn publication_crash_child() {
        let Some(root) = std::env::var_os("HERTZ_WORK_DRAFT_TEST_CRASH_AFTER_PUBLISH") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let library = Library::open(&root).await.unwrap();
        let assets = AssetStore::new(&root).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        std::fs::write(root.join("interrupted-draft-id.txt"), &draft.id).unwrap();
        drafts.publish(&draft.id, 1, &assets).await.unwrap();
        panic!("the subprocess must exit at the directory/SQL commit boundary");
    }

    #[tokio::test]
    async fn process_exit_then_real_startup_reconciliation_completes_the_original_native_publication(
    ) {
        let root = tempfileish::temp_dir("work-draft-process-recovery");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("wallpaper::work_drafts::tests::publication_crash_child")
            .arg("--nocapture")
            .env("HERTZ_WORK_DRAFT_TEST_CRASH_AFTER_PUBLISH", root.path())
            .status()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(86),
            "the real publish path must have flushed and renamed its directory"
        );
        let id = std::fs::read_to_string(root.path().join("interrupted-draft-id.txt")).unwrap();
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        assert_eq!(count(&library, "versions").await, 0);
        assert_eq!(count(&library, "draft_publications").await, 1);
        let expected: (i64, String) =
            sqlx::query_as("SELECT version,package_hash FROM draft_publications WHERE draft_id=?1")
                .bind(&id)
                .fetch_one(library.pool())
                .await
                .unwrap();
        let path = assets.package_dir(&expected.1).join("original.hwpkg");
        let before = std::fs::read(&path).unwrap();

        super::super::jobs::reconcile_startup(&library, &assets)
            .await
            .unwrap();
        assert_eq!(count(&library, "versions").await, 1);
        assert_eq!(
            count(&library, "authored_versions").await,
            0,
            "ordinary recovery does not invent native authorship"
        );
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.get(&id).await.unwrap();
        assert_eq!(draft.saved_revision, Some(1));
        assert!(draft.package_hash.is_none());
        assert!(drafts
            .references(&draft.work_key, Some(&expected.1))
            .await
            .unwrap());
        assert_eq!(
            drafts
                .update(&id, 1, vec![title("不能改写已申请发布的快照")])
                .await
                .unwrap_err()
                .code,
            "draft_busy"
        );
        assert_eq!(drafts.save(&id, 1).await.unwrap_err().code, "draft_busy");
        assert_eq!(drafts.discard(&id, 1).await.unwrap_err().code, "draft_busy");
        let recovered = drafts.publish(&id, 1, &assets).await.unwrap();
        assert_eq!(recovered.version, expected.0 as u32);
        assert_eq!(recovered.package_hash, expected.1);
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert_eq!(count(&library, "draft_publications").await, 0);
        assert_eq!(count(&library, "authored_versions").await, 1);
        assert_eq!(
            count(&library, "versions").await,
            1,
            "retry must not allocate MAX(version)+1"
        );
        assert!(drafts
            .create_from_version(&recovered.work_key, &recovered.package_hash)
            .await
            .is_ok());
        library.pool().close().await;

        let reopened = Library::open(root.path()).await.unwrap();
        super::super::jobs::reconcile_startup(&reopened, &assets)
            .await
            .unwrap();
        let drafts = WorkDrafts::new(&reopened);
        assert_eq!(drafts.publish(&id, 1, &assets).await.unwrap(), recovered);
        assert_eq!(
            drafts
                .update(&id, 1, vec![title("恢复后继续编辑")])
                .await
                .unwrap()
                .revision,
            2
        );
        reopened.pool().close().await;
    }

    #[tokio::test]
    async fn publication_intent_never_adopts_an_import_with_the_same_uuid_and_other_bytes() {
        let root = tempfileish::temp_dir("work-draft-intent-conflict");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        let saved = drafts.save(&draft.id, 1).await.unwrap();
        let (intent, _) = drafts.reserve_publication(&saved).await.unwrap();
        let mut foreign = document();
        foreign.title = "同 UUID 的第三方版本".into();
        let bytes = builtin_package(&foreign, &draft.work_id, 1).unwrap();
        let manifest = hertz_wallpaper::validate_package(Cursor::new(&bytes))
            .unwrap()
            .manifest;
        let foreign_hash = format!("{:x}", Sha256::digest(&bytes));
        assert_ne!(intent.package_hash, foreign_hash);
        library
            .install(&super::super::library::InstallWork {
                work_key: draft.work_key.clone(),
                remote_work_id: draft.work_id.clone(),
                source_id: "local".into(),
                title: manifest.title.clone(),
                description: manifest.description.clone(),
                kind: "builtin".into(),
                package_hash: foreign_hash.clone(),
                manifest_json: serde_json::to_string(&manifest).unwrap(),
                package_bytes: bytes.len() as u64,
                version: 1,
            })
            .await
            .unwrap();
        assert_eq!(
            drafts
                .publish(&draft.id, 1, &assets)
                .await
                .unwrap_err()
                .code,
            "version_hash_conflict"
        );
        assert_eq!(count(&library, "authored_versions").await, 0);
        assert_eq!(count(&library, "versions").await, 1);
        assert_eq!(
            library.versions(&draft.work_key).await.unwrap()[0].package_hash,
            foreign_hash
        );
        assert_eq!(
            drafts
                .create_from_version(&draft.work_key, &foreign_hash)
                .await
                .unwrap_err()
                .code,
            "work_not_editable"
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn two_drafts_cannot_publish_the_same_work_out_of_order() {
        let root = tempfileish::temp_dir("work-draft-publish-order");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let original = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        let branch = drafts
            .create_from_version(&original.work_key, &original.package_hash)
            .await
            .unwrap();
        drafts
            .update(&draft.id, 1, vec![title("先申请的第二版")])
            .await
            .unwrap();
        let saved = drafts.save(&draft.id, 2).await.unwrap();
        drafts.reserve_publication(&saved).await.unwrap();
        drafts
            .update(&branch.id, 1, vec![title("后申请的第三版")])
            .await
            .unwrap();
        drafts.save(&branch.id, 2).await.unwrap();
        assert_eq!(
            drafts
                .publish(&branch.id, 2, &assets)
                .await
                .unwrap_err()
                .code,
            "draft_busy"
        );
        assert_eq!(count(&library, "draft_publications").await, 1);
        assert_eq!(count(&library, "versions").await, 1);
        assert_eq!(
            drafts.publish(&draft.id, 2, &assets).await.unwrap().version,
            2
        );
        assert_eq!(
            drafts
                .publish(&branch.id, 2, &assets)
                .await
                .unwrap()
                .version,
            3
        );
        assert_eq!(
            library
                .get_work(&original.work_key)
                .await
                .unwrap()
                .unwrap()
                .title,
            "后申请的第三版"
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn import_source_local_is_not_authority_to_edit_an_imported_version() {
        let root = tempfileish::temp_dir("work-draft-authorship");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let original = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        // Imports currently share the local source and can append the same
        // logical UUID. That does not make their version native-authored.
        let bytes = builtin_package(&document(), &draft.work_id, 2).unwrap();
        let manifest = hertz_wallpaper::validate_package(Cursor::new(&bytes))
            .unwrap()
            .manifest;
        let imported_hash = "f".repeat(64);
        library
            .install(&super::super::library::InstallWork {
                work_key: draft.work_key.clone(),
                remote_work_id: draft.work_id.clone(),
                source_id: "local".into(),
                title: manifest.title.clone(),
                description: manifest.description.clone(),
                kind: "builtin".into(),
                package_hash: imported_hash.clone(),
                manifest_json: serde_json::to_string(&manifest).unwrap(),
                package_bytes: bytes.len() as u64,
                version: 2,
            })
            .await
            .unwrap();
        assert_eq!(
            drafts
                .create_from_version(&draft.work_key, &imported_hash)
                .await
                .unwrap_err()
                .code,
            "work_not_editable"
        );
        drafts.discard(&draft.id, 1).await.unwrap();
        let reopened = drafts
            .create_from_version(&original.work_key, &original.package_hash)
            .await
            .unwrap();
        assert_eq!(
            reopened.work_key, original.work_key,
            "authorship survives discarding the original draft"
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn a_flushed_package_left_before_database_commit_is_reused_on_explicit_retry() {
        let root = tempfileish::temp_dir("work-draft-retry");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts.create(document()).await.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let bytes = builtin_package(&draft.document, &draft.work_id, 1).unwrap();
        let job = "work-interrupted-fixture";
        let writer = assets.content_writer().unwrap();
        std::fs::create_dir(assets.staging_dir(job)).unwrap();
        std::fs::write(assets.staging_dir(job).join("original.hwpkg"), &bytes).unwrap();
        let package = assets.validate_staged(job).unwrap();
        writer.preflight(job, &package).unwrap();
        assets.unpack_projection(job, &package).unwrap();
        writer.publish_staging(job, &package.package_hash).unwrap();
        drop(writer);
        assert_eq!(count(&library, "versions").await, 0);
        let retried = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        assert_eq!(retried.package_hash, package.package_hash);
        assert_eq!(retried.version, 1);
        assert_eq!(count(&library, "versions").await, 1);
        assert_eq!(
            std::fs::read(
                assets
                    .package_dir(&retried.package_hash)
                    .join("original.hwpkg")
            )
            .unwrap(),
            bytes
        );
        assert_eq!(
            std::fs::read_dir(root.path().join("staging"))
                .unwrap()
                .count(),
            0
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn paged_reads_are_bounded_revision_checked_and_capacity_is_persistent() {
        let root = tempfileish::temp_dir("work-draft-pages");
        let library = Library::open(root.path()).await.unwrap();
        let drafts = WorkDrafts::new(&library);
        let first = drafts.create(document()).await.unwrap();
        let mut recovered = Map::new();
        let mut cursor = None;
        loop {
            let page = drafts
                .parameters(&first.id, 1, cursor.as_deref(), 3)
                .await
                .unwrap();
            assert!(page.params.len() <= 3);
            assert!(serde_json::to_vec(&page).unwrap().len() < PARAM_PAGE_BYTES);
            recovered.extend(page.params);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(recovered, first.document.params);
        drafts
            .update(&first.id, 1, vec![title("已变化")])
            .await
            .unwrap();
        assert_eq!(
            drafts
                .parameters(&first.id, 1, None, 20)
                .await
                .unwrap_err()
                .code,
            "draft_conflict"
        );
        for _ in 1..MAX_DRAFTS {
            drafts.create(document()).await.unwrap();
        }
        assert_eq!(
            drafts.create(document()).await.unwrap_err().code,
            "draft_limit"
        );
        let mut seen = std::collections::HashSet::new();
        let mut cursor = None;
        loop {
            let page = drafts.list(999, cursor.as_deref()).await.unwrap();
            assert!(page.drafts.len() <= 20);
            assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
            for draft in page.drafts {
                assert!(seen.insert(draft.draft_id));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), MAX_DRAFTS as usize);
        drafts.discard(&first.id, 2).await.unwrap();
        drafts.create(document()).await.unwrap();
        library.pool().close().await;
    }

    #[test]
    fn package_generation_is_deterministic_and_uses_typed_builtin_state() {
        let work_id = "c17ed10a-5c55-4a52-85dc-7509f9e88aae";
        let first = builtin_package(&document(), work_id, 1).unwrap();
        assert_eq!(first, builtin_package(&document(), work_id, 1).unwrap());
        assert_ne!(first, builtin_package(&document(), work_id, 2).unwrap());
        let parsed = hertz_wallpaper::validate_package(Cursor::new(first)).unwrap();
        assert!(!parsed.manifest.permissions.audio_spectrum);
        assert!(!parsed.manifest.permissions.pointer);
        let mut invalid = document();
        invalid.params.insert("tod".into(), json!("not a number"));
        assert!(builtin_package(&invalid, work_id, 1).is_err());
        assert!(builtin_package(&document(), work_id, 0).is_err());
    }
}
