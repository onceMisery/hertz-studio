// SPDX-License-Identifier: MIT
//! Player-owned stage assets. HTTP and DBX use this same owner; no desktop process/listener.
//! Files are installed before the index/receipt transaction. Startup replays only journals,
//! never decodes the library. A cancelled worker retains the slot until its actual I/O exits.
mod api;
mod prepare;
#[cfg(test)]
mod tests;
pub(crate) use api::{management_router, resource_router, rpc};

use crate::error::{bad_request, ApiError, ApiResult};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use vmusic_store::stage_presets as presets;

pub const CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const VIDEO_BYTES: u64 = 512 * 1024 * 1024;
const ORIGINAL_QUOTA: i64 = 10 * 1024 * 1024 * 1024;
const DERIVED_QUOTA: u64 = 256 * 1024 * 1024;
const LEASE_MS: i64 = 120_000;
fn now() -> i64 {
    vmusic_store::now_ms()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn error(code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message)
}
fn io(e: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error=%e, "stage media storage error");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "stage_storage",
        "舞台素材读写失败，请检查服务端磁盘与权限",
    )
}
pub(crate) fn preset_error(e: presets::Error) -> ApiError {
    if e.code == "stage_database" {
        return io(e);
    }
    ApiError::new(
        if e.code == "stage_preset_invalid" {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::CONFLICT
        },
        e.code,
        e.message,
    )
}

pub(crate) async fn store(state: &Arc<crate::state::AppState>) -> ApiResult<Arc<StageMediaStore>> {
    state
        .stage_media
        .get_or_init(|| StageMediaStore::open(state.db.clone(), state.data_dir.join("stage-media")))
        .await
        .clone()
}

pub(crate) struct StageMediaStore {
    db: SqlitePool,
    root: PathBuf,
    store_id: String,
    _lock: fslock::LockFile,
    // Serializes filesystem journals, asset-reference checks and preset transactions.
    gate: tokio::sync::Mutex<()>,
    active: Mutex<Option<(String, Arc<AtomicBool>)>>,
    leases: Mutex<HashMap<String, Arc<Lease>>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Begin {
    request_id: String,
    session: String,
    name: String,
    size: u64,
    media: String,
    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
}
fn default_width() -> u32 {
    1920
}
fn default_height() -> u32 {
    1080
}

#[derive(sqlx::FromRow)]
struct Import {
    import_id: String,
    metadata: String,
    token: String,
    offset: i64,
    state: String,
    asset_id: Option<String>,
    error: Option<String>,
    started_at: i64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetRef {
    store_id: String,
    asset_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Acquire {
    asset_ref: AssetRef,
    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
}
pub(crate) struct Lease {
    asset_id: String,
    path: PathBuf,
    content_key: String,
    media: String,
    mime: &'static str,
    length: u64,
    expires: AtomicI64,
}

impl StageMediaStore {
    async fn open(db: SqlitePool, root: PathBuf) -> ApiResult<Arc<Self>> {
        let lock_root = root.clone();
        let lock = tokio::task::spawn_blocking(move || -> ApiResult<_> {
            std::fs::create_dir_all(&lock_root).map_err(io)?;
            let mut lock = fslock::LockFile::open(&lock_root.join("store.lock")).map_err(io)?;
            if !lock.try_lock().map_err(io)? {
                return Err(error(
                    "stage_locked",
                    "另一实例正在使用舞台素材库；音乐播放仍可使用",
                ));
            }
            for p in ["objects", "derived", "staging", "trash"] {
                std::fs::create_dir_all(lock_root.join(p)).map_err(io)?;
            }
            Ok(lock)
        })
        .await
        .map_err(io)??;
        let meta = presets::initialize(&db).await.map_err(preset_error)?;
        let store = Arc::new(Self {
            db,
            root,
            store_id: meta["storeId"]
                .as_str()
                .ok_or_else(|| io("storeId missing"))?
                .into(),
            _lock: lock,
            gate: Default::default(),
            active: Default::default(),
            leases: Default::default(),
        });
        store.reconcile().await?;
        Ok(store)
    }
    fn original(&self, asset: &str) -> PathBuf {
        self.root.join("objects").join(asset).join("source")
    }
    fn staging(&self, import: &str) -> PathBuf {
        self.root.join("staging").join(import)
    }
    async fn import(&self, import: &str) -> ApiResult<Import> {
        sqlx::query_as("SELECT import_id,metadata,token,offset,state,asset_id,error,started_at,touched_at FROM stage_media_imports WHERE import_id=?")
            .bind(import).fetch_optional(&self.db).await.map_err(io)?.ok_or_else(|| bad_request("导入任务不存在"))
    }
    async fn reconcile(&self) -> ApiResult<()> {
        let pending: Vec<(String, String)> = sqlx::query_as(
            "SELECT asset_id,delete_id FROM stage_media_assets WHERE state='deleting'",
        )
        .fetch_all(&self.db)
        .await
        .map_err(io)?;
        for (asset, delete) in pending {
            self.finish_delete(&asset, &delete).await?;
        }
        // An install with no terminal DB receipt is interrupted. Its object is unindexed and
        // removed below; a committed receipt is never inferred from an orphan directory.
        sqlx::query("UPDATE stage_media_imports SET state='interrupted',error='服务已重启，请重新选择文件' WHERE state IN ('uploading','preparing')")
            .execute(&self.db).await.map_err(io)?;
        let mut entries = tokio::fs::read_dir(self.root.join("staging"))
            .await
            .map_err(io)?;
        while let Some(entry) = entries.next_entry().await.map_err(io)? {
            if entry.file_type().await.map_err(io)?.is_dir() {
                tokio::fs::remove_dir_all(entry.path()).await.map_err(io)?;
            }
        }
        let mut entries = tokio::fs::read_dir(self.root.join("objects"))
            .await
            .map_err(io)?;
        while let Some(entry) = entries.next_entry().await.map_err(io)? {
            let asset = entry.file_name().to_string_lossy().to_string();
            if !presets::valid_id(&asset) || !entry.file_type().await.map_err(io)?.is_dir() {
                continue;
            }
            let exists: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM stage_media_assets WHERE asset_id=?")
                    .bind(&asset)
                    .fetch_one(&self.db)
                    .await
                    .map_err(io)?;
            if exists == 0 {
                tokio::fs::remove_dir_all(entry.path()).await.map_err(io)?;
            }
        }
        let assets: Vec<String> =
            sqlx::query_scalar("SELECT asset_id FROM stage_media_assets WHERE state='ready'")
                .fetch_all(&self.db)
                .await
                .map_err(io)?;
        for asset in assets {
            if !self.original(&asset).is_file() {
                sqlx::query("UPDATE stage_media_assets SET state='missing' WHERE asset_id=?")
                    .bind(asset)
                    .execute(&self.db)
                    .await
                    .map_err(io)?;
            }
        }
        Ok(())
    }
    async fn expire_upload(&self) -> ApiResult<()> {
        let old: Vec<String> = sqlx::query_scalar("SELECT import_id FROM stage_media_imports WHERE state='uploading' AND (touched_at<? OR started_at<?)")
            .bind(now()-60_000).bind(now()-900_000).fetch_all(&self.db).await.map_err(io)?;
        for import in old {
            self.terminal(&import, "expired", Some("上传已过期，请重新选择文件"))
                .await?;
        }
        Ok(())
    }
    async fn terminal(&self, import: &str, state: &str, message: Option<&str>) -> ApiResult<()> {
        sqlx::query("UPDATE stage_media_imports SET state=?,error=?,token='' WHERE import_id=? AND state!='committed'")
            .bind(state).bind(message).bind(import).execute(&self.db).await.map_err(io)?;
        let receipt = self.import(import).await?;
        if receipt.state != "committed" {
            if let Some(asset) = receipt.asset_id.filter(|id| presets::valid_id(id)) {
                let indexed: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM stage_media_assets WHERE asset_id=?")
                        .bind(&asset)
                        .fetch_one(&self.db)
                        .await
                        .map_err(io)?;
                if indexed == 0 {
                    for directory in ["objects", "derived"] {
                        let orphan = self.root.join(directory).join(&asset);
                        if orphan.exists() {
                            tokio::fs::remove_dir_all(orphan).await.map_err(io)?;
                        }
                    }
                }
            }
        }
        let path = self.staging(import);
        if path.exists() {
            tokio::fs::remove_dir_all(path).await.map_err(io)?;
        }
        let mut active = self.active.lock().unwrap();
        if active.as_ref().is_some_and(|(i, _)| i == import) {
            *active = None;
        }
        Ok(())
    }
    pub(crate) async fn begin(&self, input: Begin) -> ApiResult<Value> {
        if input.request_id.is_empty()
            || input.request_id.len() > 128
            || input.session.is_empty()
            || input.session.len() > 128
            || input.name.trim().is_empty()
            || input.name.chars().count() > 255
            || input.name.contains(['/', '\\'])
            || input.size == 0
            || input.size
                > if input.media == "image" {
                    IMAGE_BYTES
                } else {
                    VIDEO_BYTES
                }
            || !matches!(input.media.as_str(), "image" | "video")
            || input.width == 0
            || input.height == 0
            || input.width.max(input.height) > 8192
        {
            return Err(bad_request(
                "文件信息无效；图片最多 32 MiB，视频最多 512 MiB",
            ));
        }
        let _guard = self.gate.lock().await;
        self.expire_upload().await?;
        let digest = presets::digest(&serde_json::to_value(&input).map_err(io)?);
        let previous: Option<(String, String)> =
            sqlx::query_as("SELECT import_id,digest FROM stage_media_imports WHERE request_id=?")
                .bind(&input.request_id)
                .fetch_optional(&self.db)
                .await
                .map_err(io)?;
        if let Some((import, old)) = previous {
            if old != digest {
                return Err(error("stage_request_conflict", "导入请求的内容发生变化"));
            }
            let row = self.import(&import).await?;
            return Ok(
                json!({"importId":import,"uploadToken":row.token,"status":row.state,"offset":row.offset}),
            );
        }
        if self.active.lock().unwrap().is_some() {
            return Err(error(
                "stage_import_busy",
                "另一素材正在上传或准备，请完成或取消后再导入",
            ));
        }
        let (count, bytes): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM stage_media_assets")
                .fetch_one(&self.db)
                .await
                .map_err(io)?;
        // Admit one bounded staging file even at quota so an identical/missing asset can be
        // repaired. The exact unique quota is checked before installation.
        if count > 2000 || bytes > ORIGINAL_QUOTA {
            return Err(error(
                "stage_quota",
                "素材库额度已满，请先删除不再使用的素材",
            ));
        }
        let import = id();
        let upload = token();
        tokio::fs::create_dir(self.staging(&import))
            .await
            .map_err(io)?;
        tokio::fs::File::create(self.staging(&import).join("source"))
            .await
            .map_err(io)?;
        sqlx::query("INSERT INTO stage_media_imports(import_id,request_id,digest,metadata,token,state,started_at,touched_at) VALUES(?,?,?,?,?,'uploading',?,?)")
            .bind(&import).bind(&input.request_id).bind(digest).bind(serde_json::to_string(&input).map_err(io)?).bind(&upload).bind(now()).bind(now())
            .execute(&self.db).await.map_err(io)?;
        *self.active.lock().unwrap() = Some((import.clone(), Arc::new(AtomicBool::new(false))));
        Ok(
            json!({"importId":import,"uploadToken":upload,"status":"uploading","offset":0,"chunkBytes":CHUNK_BYTES,"storeId":self.store_id}),
        )
    }
    pub(crate) async fn chunk(
        &self,
        import: &str,
        upload: &str,
        offset: u64,
        hash: &str,
        bytes: &[u8],
    ) -> ApiResult<Value> {
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES || !presets::valid_id(hash) {
            return Err(bad_request("素材块必须为 1–256 KiB，且携带 SHA-256"));
        }
        if format!("{:x}", Sha256::digest(bytes)) != hash {
            return Err(error("stage_chunk_hash", "素材块校验失败"));
        }
        let _guard = self.gate.lock().await;
        self.expire_upload().await?;
        let row = self.import(import).await?;
        if row.state != "uploading" || row.token != upload || upload.is_empty() {
            return Err(error("stage_import_closed", "上传已关闭或上传凭据无效"));
        }
        let meta: Begin = serde_json::from_str(&row.metadata).map_err(io)?;
        if offset > row.offset as u64
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|n| n > meta.size)
        {
            return Err(error("stage_chunk_order", "素材块顺序或长度错误"));
        }
        let mut file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.staging(import).join("source"))
            .await
            .map_err(io)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(io)?;
        if offset < row.offset as u64 {
            let accepted: Option<(i64, String)> = sqlx::query_as(
                "SELECT bytes,sha256 FROM stage_media_chunks WHERE import_id=? AND offset=?",
            )
            .bind(import)
            .bind(offset as i64)
            .fetch_optional(&self.db)
            .await
            .map_err(io)?;
            if !accepted
                .is_some_and(|(length, digest)| length == bytes.len() as i64 && digest == hash)
            {
                return Err(error(
                    "stage_chunk_conflict",
                    "同一偏移的素材块长度或哈希不同",
                ));
            }
            if offset + bytes.len() as u64 > row.offset as u64 {
                return Err(error("stage_chunk_order", "素材块与已接收数据重叠"));
            }
            let mut old = vec![0; bytes.len()];
            file.read_exact(&mut old).await.map_err(io)?;
            if old != bytes {
                return Err(error("stage_chunk_conflict", "重复素材块内容不同"));
            }
        } else {
            file.write_all(bytes).await.map_err(io)?;
            file.sync_data().await.map_err(io)?;
            let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await.map_err(io)?;
            sqlx::query(
                "INSERT INTO stage_media_chunks(import_id,offset,bytes,sha256) VALUES(?,?,?,?)",
            )
            .bind(import)
            .bind(offset as i64)
            .bind(bytes.len() as i64)
            .bind(hash)
            .execute(&mut *tx)
            .await
            .map_err(io)?;
            sqlx::query("UPDATE stage_media_imports SET offset=? WHERE import_id=?")
                .bind((offset + bytes.len() as u64) as i64)
                .bind(import)
                .execute(&mut *tx)
                .await
                .map_err(io)?;
            tx.commit().await.map_err(io)?;
        }
        sqlx::query("UPDATE stage_media_imports SET touched_at=? WHERE import_id=?")
            .bind(now())
            .bind(import)
            .execute(&self.db)
            .await
            .map_err(io)?;
        Ok(json!({"offset":self.import(import).await?.offset}))
    }
    pub(crate) async fn status(&self, import: &str) -> ApiResult<Value> {
        let row = self.import(import).await?;
        let meta: Begin = serde_json::from_str(&row.metadata).map_err(io)?;
        let asset_ref = if row.state == "committed" {
            row.asset_id
                .map(|asset| json!({"storeId":self.store_id,"assetId":asset}))
        } else {
            None
        };
        Ok(
            json!({"importId":row.import_id,"jobId":row.import_id,"status":row.state,"offset":row.offset,"size":meta.size,
            "assetRef":asset_ref,"media":meta.media,"error":row.error}),
        )
    }
    pub(crate) async fn finish(self: &Arc<Self>, import: &str) -> ApiResult<Value> {
        let _guard = self.gate.lock().await;
        self.expire_upload().await?;
        let row = self.import(import).await?;
        if row.state != "uploading" {
            return self.status(import).await;
        }
        let meta: Begin = serde_json::from_str(&row.metadata).map_err(io)?;
        if row.offset as u64 != meta.size {
            return Err(error("stage_upload_incomplete", "文件尚未上传完整"));
        }
        sqlx::query("UPDATE stage_media_imports SET state='preparing',token='' WHERE import_id=?")
            .bind(import)
            .execute(&self.db)
            .await
            .map_err(io)?;
        let cancel = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(i, _)| i == import)
            .map(|(_, c)| c.clone())
            .ok_or_else(|| error("stage_interrupted", "导入已中断"))?;
        let owner = self.clone();
        let import = import.to_string();
        tokio::spawn(async move {
            let _guard = owner.gate.lock().await;
            // Cancellation can acquire the gate before this worker gets its first poll.
            // A terminal journal must not be changed back to failed/preparing afterwards.
            if !owner
                .import(&import)
                .await
                .is_ok_and(|row| row.state == "preparing")
            {
                return;
            }
            let result = owner.install(&import, &meta, cancel.clone()).await;
            if let Err(e) = result {
                let state = if cancel.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "failed"
                };
                if let Err(e) = owner.terminal(&import, state, Some(&e.message)).await {
                    tracing::warn!(error=?e,"stage import cleanup failed");
                }
            } else {
                if let Err(e) = owner.terminal(&import, "committed", None).await {
                    tracing::warn!(error=?e,"stage import staging cleanup failed");
                }
            }
        });
        Ok(json!({"importId":row.import_id,"jobId":row.import_id,"status":"preparing"}))
    }
    async fn install(&self, import: &str, meta: &Begin, cancel: Arc<AtomicBool>) -> ApiResult<()> {
        let source = self.staging(import).join("source");
        let metadata = meta.clone();
        let row = self.import(import).await?;
        let deadline = row.started_at + 900_000;
        let flag = cancel.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            prepare::validate(&source, &metadata, &flag, deadline)
        })
        .await
        .map_err(io)??;
        if cancel.load(Ordering::Acquire) || now() > deadline {
            return Err(error("stage_cancelled", "导入已取消或超过 15 分钟"));
        }
        let asset = &prepared.asset_id;
        let existing: Option<(i64, String)> =
            sqlx::query_as("SELECT bytes,state FROM stage_media_assets WHERE asset_id=?")
                .bind(asset)
                .fetch_optional(&self.db)
                .await
                .map_err(io)?;
        let (count, total): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM stage_media_assets")
                .fetch_one(&self.db)
                .await
                .map_err(io)?;
        if count + if existing.is_none() { 1 } else { 0 } > 2000
            || total - existing.as_ref().map_or(0, |(bytes, _)| *bytes) + meta.size as i64
                > ORIGINAL_QUOTA
        {
            return Err(error(
                "stage_quota",
                "素材库上限为 2,000 项 / 10 GiB，请删除不再使用的素材",
            ));
        }
        let destination = self.original(asset);
        let check = destination.clone();
        let expected = asset.clone();
        let flag = cancel.clone();
        let expected_size = meta.size;
        let valid = tokio::task::spawn_blocking(move || {
            check.metadata().is_ok_and(|m| m.len() == expected_size)
                && prepare::hash_file(&check, &flag, deadline).is_ok_and(|h| h == expected)
        })
        .await
        .map_err(io)?;
        // Journal the intended hash before touching objects. Failed installs can clean only
        // their unindexed object; a prior committed/deduplicated object remains protected.
        sqlx::query("UPDATE stage_media_imports SET asset_id=? WHERE import_id=?")
            .bind(asset)
            .bind(import)
            .execute(&self.db)
            .await
            .map_err(io)?;
        if !valid {
            // A corrupt object is replaceable only when it is not being read. Keep its
            // index row and content identity so old saved references are repaired in place.
            if self.pinned(asset) {
                return Err(error(
                    "stage_asset_in_use",
                    "素材正在显示，请切换背景后重试修复",
                ));
            }
            if destination.exists() {
                tokio::fs::remove_file(&destination).await.map_err(io)?;
            }
            tokio::fs::create_dir_all(destination.parent().unwrap())
                .await
                .map_err(io)?;
            tokio::fs::rename(self.staging(import).join("source"), &destination)
                .await
                .map_err(io)?;
        }
        if let Some(image) = prepared.image {
            let target = self.derived(asset, meta.width, meta.height);
            // Same content/options produce the same variant. Existing leases keep their file.
            if !target.exists() {
                self.reserve_derived(image.metadata().map_err(io)?.len(), Some(&target))
                    .await?;
                tokio::fs::create_dir_all(target.parent().unwrap())
                    .await
                    .map_err(io)?;
                tokio::fs::rename(image, &target).await.map_err(io)?;
            }
        }
        // From this point installation wins a racing cancel, and the committed asset stays.
        let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await.map_err(io)?;
        sqlx::query("INSERT INTO stage_media_assets(asset_id,name,media,bytes,metadata,state,created_at) VALUES(?,?,?,?,?,'ready',?) ON CONFLICT(asset_id) DO UPDATE SET state='ready',delete_id=NULL,metadata=excluded.metadata,bytes=excluded.bytes")
            .bind(asset).bind(&meta.name).bind(&meta.media).bind(meta.size as i64).bind(prepared.metadata.to_string()).bind(now()).execute(&mut *tx).await.map_err(io)?;
        sqlx::query("UPDATE stage_media_imports SET state='committed',asset_id=?,error=NULL,token='' WHERE import_id=?")
            .bind(asset).bind(import).execute(&mut *tx).await.map_err(io)?;
        tx.commit().await.map_err(io)?;
        Ok(())
    }
    pub(crate) async fn cancel(&self, import: &str) -> ApiResult<Value> {
        if let Some((_, flag)) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(i, _)| i == import)
        {
            flag.store(true, Ordering::Release);
        }
        let _guard = self.gate.lock().await; // joins any blocking preparation/install before freeing slot
        let row = self.import(import).await?;
        if matches!(row.state.as_str(), "uploading" | "preparing") {
            self.terminal(import, "cancelled", Some("已取消导入"))
                .await?;
        }
        self.status(import).await
    }
    fn derived(&self, asset: &str, width: u32, height: u32) -> PathBuf {
        self.root.join("derived").join(asset).join(format!(
            "v1-{}x{}.png",
            width.div_ceil(256) * 256,
            height.div_ceil(256) * 256
        ))
    }
    fn prune_leases(leases: &mut HashMap<String, Arc<Lease>>) {
        leases.retain(|_, v| v.expires.load(Ordering::Acquire) > now() || Arc::strong_count(v) > 1);
    }
    fn pinned(&self, asset: &str) -> bool {
        let mut leases = self.leases.lock().unwrap();
        Self::prune_leases(&mut leases);
        leases.values().any(|v| v.asset_id == asset)
    }
    async fn reserve_derived(&self, extra: u64, preserve: Option<&Path>) -> ApiResult<()> {
        let root = self.root.join("derived");
        let pinned: Vec<PathBuf> = {
            let mut leases = self.leases.lock().unwrap();
            Self::prune_leases(&mut leases);
            leases.values().map(|l| l.path.clone()).collect()
        };
        let preserve = preserve.map(Path::to_path_buf);
        tokio::task::spawn_blocking(move || -> ApiResult<()> {
            let mut entries = vec![];
            let mut total = 0;
            for directory in std::fs::read_dir(root).map_err(io)? {
                let directory = directory.map_err(io)?;
                if !directory.file_type().map_err(io)?.is_dir() {
                    continue;
                }
                for file in std::fs::read_dir(directory.path()).map_err(io)? {
                    let file = file.map_err(io)?;
                    let meta = file.metadata().map_err(io)?;
                    if !meta.is_file() {
                        continue;
                    }
                    total += meta.len();
                    entries.push((meta.modified().ok(), file.path(), meta.len()));
                }
            }
            entries.sort_by_key(|e| e.0);
            for (_, path, bytes) in entries {
                if total + extra <= DERIVED_QUOTA {
                    break;
                }
                if pinned.contains(&path) || preserve.as_ref() == Some(&path) {
                    continue;
                }
                std::fs::remove_file(path).map_err(io)?;
                total -= bytes;
            }
            if total + extra > DERIVED_QUOTA {
                return Err(error(
                    "stage_derived_quota",
                    "正在使用的图片缓存已达上限，请关闭其他预览后重试",
                ));
            }
            Ok(())
        })
        .await
        .map_err(io)?
    }
    pub(crate) async fn acquire(&self, request: Acquire, dbx: bool) -> ApiResult<Value> {
        if request.asset_ref.store_id != self.store_id {
            return Err(error(
                "stage_store_mismatch",
                "素材属于另一服务设备，请在当前服务重新导入",
            ));
        }
        let asset = request.asset_ref.asset_id;
        if !presets::valid_id(&asset)
            || request.width == 0
            || request.height == 0
            || request.width.max(request.height) > 8192
        {
            return Err(bad_request("素材引用或目标尺寸无效"));
        }
        let _guard = self.gate.lock().await;
        let row: Option<(String, String, String)> =
            sqlx::query_as("SELECT media,metadata,state FROM stage_media_assets WHERE asset_id=?")
                .bind(&asset)
                .fetch_optional(&self.db)
                .await
                .map_err(io)?;
        let (media, metadata, state) =
            row.ok_or_else(|| error("stage_asset_missing", "素材不存在，请重新导入"))?;
        if state != "ready" {
            return Err(error(
                "stage_asset_unavailable",
                "素材不可用，请重新导入修复",
            ));
        }
        if dbx && media == "video" {
            return Err(error(
                "stage_video_stream_unavailable",
                "当前 DBX 宿主尚不支持有界视频流；素材已保留，可在独立版中使用",
            ));
        }
        let source = self.original(&asset);
        if !source.is_file() {
            sqlx::query("UPDATE stage_media_assets SET state='missing' WHERE asset_id=?")
                .bind(&asset)
                .execute(&self.db)
                .await
                .map_err(io)?;
            return Err(error("stage_asset_missing", "素材文件缺失，请重新导入修复"));
        }
        let metadata: Value = serde_json::from_str(&metadata).map_err(io)?;
        let (path, mime) = if media == "image" {
            let target = self.derived(&asset, request.width, request.height);
            if !target.is_file() {
                self.reserve_derived(IMAGE_BYTES, None).await?;
                let dest = target.clone();
                let input = source.clone();
                let width = request.width;
                let height = request.height;
                let expected = asset.clone();
                let rebuilt = tokio::task::spawn_blocking(move || {
                    if input.metadata().map_err(io)?.len() > IMAGE_BYTES
                        || prepare::hash_file(&input, &AtomicBool::new(false), now() + 60_000)?
                            != expected
                    {
                        return Err(error(
                            "stage_asset_corrupt",
                            "素材原文件校验失败，请重新导入修复",
                        ));
                    }
                    prepare::image(
                        &input,
                        &dest,
                        width.div_ceil(256) * 256,
                        height.div_ceil(256) * 256,
                    )
                })
                .await
                .map_err(io)?;
                if let Err(e) = rebuilt {
                    if e.code == "stage_asset_corrupt" {
                        sqlx::query(
                            "UPDATE stage_media_assets SET state='quarantined' WHERE asset_id=?",
                        )
                        .bind(&asset)
                        .execute(&self.db)
                        .await
                        .map_err(io)?;
                    }
                    return Err(e);
                }
            }
            (target, "image/png")
        } else {
            (
                source,
                if metadata["container"] == "mp4" {
                    "video/mp4"
                } else {
                    "video/webm"
                },
            )
        };
        let length = tokio::fs::metadata(&path).await.map_err(io)?.len();
        if media == "image" && length > IMAGE_BYTES {
            return Err(error("stage_image_budget", "准备后的图片超过 32 MiB"));
        }
        let content_key = format!("{}:{}", asset, path.file_name().unwrap().to_string_lossy());
        let mut leases = self.leases.lock().unwrap();
        Self::prune_leases(&mut leases);
        if leases.len() >= 128 {
            return Err(error("stage_lease_limit", "打开的素材过多，请关闭其他预览"));
        }
        let lease_token = token();
        leases.insert(
            lease_token.clone(),
            Arc::new(Lease {
                asset_id: asset,
                path,
                content_key: content_key.clone(),
                media: media.clone(),
                mime,
                length,
                expires: AtomicI64::new(now() + LEASE_MS),
            }),
        );
        Ok(
            json!({"leaseId":lease_token,"url":if dbx {Value::Null}else{json!(format!("/v1/stage/media/resource/{lease_token}"))},
            "contentKey":content_key,"length":length,"mime":mime,"media":media,"ttlMs":LEASE_MS,"chunkBytes":CHUNK_BYTES}),
        )
    }
    fn lease(&self, token: &str) -> ApiResult<Arc<Lease>> {
        let mut leases = self.leases.lock().unwrap();
        Self::prune_leases(&mut leases);
        leases
            .get(token)
            .filter(|l| l.expires.load(Ordering::Acquire) > now())
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "stage_lease_expired",
                    "素材读取凭据已过期，请重新载入背景",
                )
            })
    }
    pub(crate) fn renew(&self, token: &str) -> ApiResult<Value> {
        self.lease(token)?
            .expires
            .store(now() + LEASE_MS, Ordering::Release);
        Ok(json!({"ttlMs":LEASE_MS}))
    }
    pub(crate) fn release(&self, token: &str) -> Value {
        // Streams retain an Arc and still protect deletion until their file handle closes.
        if let Some(lease) = self.leases.lock().unwrap().get(token) {
            lease.expires.store(0, Ordering::Release);
        }
        json!({"ok":true})
    }
    pub(crate) async fn read_image(
        &self,
        token: &str,
        offset: u64,
        count: usize,
    ) -> ApiResult<Value> {
        if count == 0 || count > CHUNK_BYTES {
            return Err(bad_request("图片读取块最多 256 KiB"));
        }
        let lease = self.lease(token)?;
        if lease.media != "image" || lease.length > IMAGE_BYTES {
            return Err(error(
                "stage_video_stream_unavailable",
                "DBX 块读取仅支持准备后的静态图片",
            ));
        }
        if offset >= lease.length {
            return Err(bad_request("图片偏移超出边界"));
        }
        let mut file = tokio::fs::File::open(&lease.path).await.map_err(io)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(io)?;
        let mut data = vec![0; count.min((lease.length - offset) as usize)];
        file.read_exact(&mut data).await.map_err(io)?;
        Ok(
            json!({"offset":offset,"length":lease.length,"contentKey":lease.content_key,"dataBase64":crate::rpc::encode_base64(&data)}),
        )
    }
    pub(crate) async fn list(&self, offset: u64) -> ApiResult<Value> {
        let _guard = self.gate.lock().await;
        let saved = presets::load(&self.db).await.map_err(preset_error)?;
        let mut refs = presets::references(&saved["current"]);
        refs.extend(presets::references(&saved["library"]));
        let rows: Vec<(String,String,String,i64,String)>=sqlx::query_as("SELECT asset_id,name,media,bytes,state FROM stage_media_assets ORDER BY created_at DESC,asset_id LIMIT 50 OFFSET ?")
            .bind(offset.min(i64::MAX as u64) as i64).fetch_all(&self.db).await.map_err(io)?;
        let mut assets = vec![];
        for (asset, name, media, bytes, mut status) in rows {
            if status == "ready" && !self.original(&asset).is_file() {
                status = "missing".into();
                sqlx::query("UPDATE stage_media_assets SET state='missing' WHERE asset_id=?")
                    .bind(&asset)
                    .execute(&self.db)
                    .await
                    .map_err(io)?;
            }
            assets.push(json!({"assetRef":{"storeId":self.store_id,"assetId":asset},"name":name,"media":media,"bytes":bytes,"status":status,
                "referenced":refs.contains(&(self.store_id.clone(),asset.clone())),"inUse":self.pinned(&asset)}));
        }
        let (count, bytes): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM stage_media_assets")
                .fetch_one(&self.db)
                .await
                .map_err(io)?;
        Ok(
            json!({"items":assets,"total":count,"bytes":bytes,"quotaBytes":ORIGINAL_QUOTA,"storeId":self.store_id}),
        )
    }
    pub(crate) async fn delete(&self, asset: &str) -> ApiResult<Value> {
        if !presets::valid_id(asset) {
            return Err(bad_request("素材 id 无效"));
        }
        let _guard = self.gate.lock().await;
        let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await.map_err(io)?;
        for key in [presets::CURRENT, presets::LIBRARY] {
            let value = presets::read(&mut tx, key)
                .await
                .map_err(preset_error)?
                .unwrap_or(Value::Null);
            if presets::references(&value).contains(&(self.store_id.clone(), asset.into())) {
                return Err(error(
                    "stage_asset_referenced",
                    "当前舞台或预设库仍引用此素材，请先更换或移除引用",
                ));
            }
        }
        if self.pinned(asset) {
            return Err(error(
                "stage_asset_in_use",
                "素材仍在显示或预览，请先关闭相关背景",
            ));
        }
        let delete = id();
        sqlx::query("UPDATE stage_media_assets SET state='deleting',delete_id=? WHERE asset_id=? AND state!='deleting'").bind(&delete).bind(asset).execute(&mut *tx).await.map_err(io)?;
        tx.commit().await.map_err(io)?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT delete_id FROM stage_media_assets WHERE asset_id=?")
                .bind(asset)
                .fetch_optional(&self.db)
                .await
                .map_err(io)?;
        if let Some(delete) = existing {
            self.finish_delete(asset, &delete).await?;
        }
        Ok(json!({"ok":true}))
    }
    async fn finish_delete(&self, asset: &str, delete: &str) -> ApiResult<()> {
        if !presets::valid_id(asset) || uuid::Uuid::parse_str(delete).is_err() {
            return Err(io("invalid deletion journal"));
        }
        let trash = self.root.join("trash").join(delete);
        tokio::fs::create_dir_all(&trash).await.map_err(io)?;
        let original = self.root.join("objects").join(asset);
        let moved = trash.join(asset);
        if original.exists() && !moved.exists() {
            tokio::fs::rename(original, &moved).await.map_err(io)?;
        }
        let derived = self.root.join("derived").join(asset);
        if derived.exists() && !trash.join("derived").exists() {
            tokio::fs::rename(derived, trash.join("derived"))
                .await
                .map_err(io)?;
        }
        // Cleanup only this deletion generation, never a subsequently reimported hash path.
        tokio::fs::remove_dir_all(&trash).await.map_err(io)?;
        sqlx::query(
            "DELETE FROM stage_media_assets WHERE asset_id=? AND state='deleting' AND delete_id=?",
        )
        .bind(asset)
        .bind(delete)
        .execute(&self.db)
        .await
        .map_err(io)?;
        Ok(())
    }
    pub(crate) async fn save(&self, request: presets::Save) -> ApiResult<Value> {
        let _guard = self.gate.lock().await;
        for (store, asset) in presets::references(&request.payload) {
            if store == self.store_id
                && presets::valid_id(&asset)
                && !self.original(&asset).is_file()
            {
                sqlx::query("UPDATE stage_media_assets SET state='missing' WHERE asset_id=? AND state='ready'")
                    .bind(asset).execute(&self.db).await.map_err(io)?;
            }
        }
        presets::save(&self.db, &request)
            .await
            .map_err(preset_error)
    }
    pub(crate) async fn restore_backup(
        &self,
        file: &vmusic_store::backup::BackupFile,
    ) -> ApiResult<vmusic_store::backup::RestoreReport> {
        let _guard = self.gate.lock().await;
        vmusic_store::backup::restore(&self.db, file)
            .await
            .map_err(|e| bad_request(e.to_string()))
    }
}
