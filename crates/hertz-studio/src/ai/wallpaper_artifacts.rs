// SPDX-License-Identifier: MIT
//! Immutable wallpaper results; the existing AI job remains the execution owner.
use crate::{
    error::{internal, ApiError, ApiResult},
    state::AppState,
};
use hertz_wallpaper::generation::{WallpaperGenerateRequest, MAX_OUTPUT_BYTES};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub(super) const RETENTION_MS: i64 = 24 * 60 * 60_000;
const MAX_RESULTS: i64 = 8;
const MAX_BYTES: i64 = 256 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Runtime {
    pub(super) gate: tokio::sync::Mutex<()>,
    writers: Mutex<HashSet<String>>,
    readers: Mutex<HashMap<String, usize>>,
    retention_started: std::sync::atomic::AtomicBool,
    retention_wake: tokio::sync::Notify,
}
struct WritePin {
    runtime: Arc<Runtime>,
    artifact_id: String,
}
impl Drop for WritePin {
    fn drop(&mut self) {
        self.runtime
            .writers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.artifact_id);
    }
}
pub(super) struct Prepared {
    artifact_id: String,
    bytes: i64,
    sha256: String,
    _pin: Arc<WritePin>,
}
pub(super) struct ImageWorkspace {
    pub(super) directory: PathBuf,
    pin: Arc<WritePin>,
    #[cfg(test)]
    isolated: bool,
}
#[cfg(test)]
impl ImageWorkspace {
    pub(super) fn isolated() -> std::io::Result<Arc<Self>> {
        let directory =
            std::env::temp_dir().join(format!("hertz-test-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory)?;
        Ok(Arc::new(Self {
            directory,
            pin: Arc::new(WritePin {
                runtime: Arc::new(Runtime::default()),
                artifact_id: uuid::Uuid::new_v4().to_string(),
            }),
            isolated: true,
        }))
    }
}
#[cfg(test)]
impl Drop for ImageWorkspace {
    fn drop(&mut self) {
        if self.isolated {
            let _ = std::fs::remove_dir(&self.directory);
        }
    }
}
pub(super) async fn image_workspace(
    state: &Arc<AppState>,
    job_id: &str,
    deadline: tokio::time::Instant,
) -> ApiResult<Arc<ImageWorkspace>> {
    let runtime = state.ai_runtime.wallpaper_artifacts.clone();
    let gate = tokio::time::timeout_at(deadline, runtime.gate.lock())
        .await
        .map_err(|_| failure("image_timeout", "图像执行期限已到"))?;
    let id:Option<String>=tokio::time::timeout_at(deadline,sqlx::query_scalar("SELECT artifact_id FROM ai_wallpaper_artifacts WHERE job_id=? AND state='writing' AND kind='image'")
        .bind(job_id).fetch_optional(&state.db)).await.map_err(|_|failure("image_timeout","图像执行期限已到"))?.map_err(sql)?;
    let id = id.ok_or_else(|| failure("artifact_unavailable", "图像预留已失效"))?;
    if !runtime
        .writers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone())
    {
        return Err(failure("artifact_busy", "图像文件正在写入"));
    }
    let pin = Arc::new(WritePin {
        runtime: runtime.clone(),
        artifact_id: id.clone(),
    });
    let directory = directory(&root(state)?, &id)?;
    drop(gate);
    tokio::task::spawn_blocking(move || {
        let workspace = ImageWorkspace {
            directory,
            pin,
            #[cfg(test)]
            isolated: false,
        };
        std::fs::create_dir_all(&workspace.directory)
            .map_err(|_| failure("artifact_io", "无法建立图像暂存目录"))?;
        Ok(Arc::new(workspace))
    })
    .await
    .map_err(|_| internal("图像暂存目录未完成"))?
}
fn sql(error: sqlx::Error) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(
        vmusic_core::StoreError::Database(error.to_string()),
    ))
}
fn store(error: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(error))
}
async fn grant_authority(
    state: &Arc<AppState>,
    principal: &str,
    owner: &str,
    scope: &str,
) -> ApiResult<()> {
    if principal == crate::idempotency::LOCAL_OWNER {
        return Ok(());
    }
    let grant = vmusic_store::ai::find_grant_by_id(&state.db, principal)
        .await
        .map_err(store)?
        .ok_or_else(crate::error::unauthorized)?;
    super::wallpaper_pairing::validate_grant(state, &grant).await?;
    let scopes: Vec<String> = serde_json::from_str(&grant.scopes).unwrap_or_default();
    if owner != principal || !scopes.iter().any(|s| s == scope) {
        return Err(crate::error::unauthorized());
    }
    Ok(())
}
fn failure(code: &'static str, message: &str) -> ApiError {
    ApiError::new(axum::http::StatusCode::CONFLICT, code, message)
}
fn root(state: &AppState) -> ApiResult<PathBuf> {
    if state.data_dir.as_os_str().is_empty() {
        return Err(failure("artifact_store_unavailable", "生成结果目录不可用"));
    }
    Ok(state.data_dir.join("ai").join("wallpaper-artifacts"))
}
fn directory(root: &std::path::Path, id: &str) -> ApiResult<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(failure("artifact_unavailable", "生成结果标识无效"));
    }
    Ok(root.join(id))
}

/// Reserve before committing admission and before any provider call. Pending
/// reservations count separately from files already deducted by the filesystem.
pub(super) async fn reserve(
    state: &AppState,
    conn: &mut sqlx::SqliteConnection,
    job: &vmusic_store::ai_jobs::JobRow,
    request: &WallpaperGenerateRequest,
) -> ApiResult<()> {
    let (count, reserved, pending): (i64,i64,i64) = sqlx::query_as(
        "SELECT COUNT(*),COALESCE(SUM(a.reserved_bytes),0),COALESCE(SUM(CASE WHEN a.state='writing' THEN a.reserved_bytes ELSE 0 END),0)
         FROM ai_wallpaper_artifacts a JOIN ai_jobs j ON j.job_id=a.job_id
         WHERE j.owner_instance_id=? AND a.state!='deleted'"
    ).bind(&job.owner_instance_id).fetch_one(&mut *conn).await.map_err(sql)?;
    let (bound, kind, mime) = match request.output.kind {
        hertz_wallpaper::generation::WallpaperGenerationKind::Builtin => {
            (MAX_OUTPUT_BYTES as i64, "builtin", "application/json")
        }
        hertz_wallpaper::generation::WallpaperGenerationKind::Image => (
            hertz_wallpaper::generation::MAX_ARTIFACT_BYTES as i64,
            "image",
            "image/png",
        ),
        _ => return Err(failure("provider_unavailable", "组合生成尚未就绪")),
    };
    if count >= MAX_RESULTS || reserved.saturating_add(bound) > MAX_BYTES {
        return Err(failure(
            "artifact_capacity_exceeded",
            "未保存的生成结果已达到容量上限，请先明确删除不需要的候选",
        ));
    }
    let data_dir = state.data_dir.clone();
    root(state)?;
    let free = tokio::task::spawn_blocking(move || fs2::available_space(data_dir))
        .await
        .map_err(|_| internal("结果容量检查未完成"))?
        .map_err(|_| {
            failure(
                "artifact_store_unavailable",
                "无法检查生成结果目录的剩余空间",
            )
        })?;
    let temporary_headroom = if kind == "image" {
        96 * 1024 * 1024
    } else {
        64 * 1024
    };
    if free
        < pending
            .saturating_add(bound)
            .saturating_add(temporary_headroom) as u64
    {
        return Err(failure(
            "artifact_disk_full",
            "磁盘剩余空间不足，未提交生成任务",
        ));
    }
    sqlx::query("INSERT INTO ai_wallpaper_artifacts(artifact_id,job_id,access_principal,state,reserved_bytes,kind,mime,registry_hash,generation_schema_hash,created_at,expires_at)
        VALUES(?,?,?,'writing',?,?,?,?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&job.job_id).bind(&job.principal).bind(bound)
        .bind(kind).bind(mime)
        .bind(&request.registry_hash).bind(&request.generation_schema_hash)
        .bind(job.created_at).bind(job.created_at.saturating_add(RETENTION_MS))
        .execute(&mut *conn).await.map_err(sql)?;
    Ok(())
}

/// The pin lives in the actual blocking file owner and then through the result
/// transaction. Observer cancellation cannot release capacity during real I/O.
pub(super) async fn prepare(
    state: &Arc<AppState>,
    job_id: &str,
    payload: String,
) -> ApiResult<Prepared> {
    let gate = state.ai_runtime.wallpaper_artifacts.gate.lock().await;
    let row: Option<(String,i64)> = sqlx::query_as(
        "SELECT artifact_id,reserved_bytes FROM ai_wallpaper_artifacts WHERE job_id=? AND state='writing'"
    ).bind(job_id).fetch_optional(&state.db).await.map_err(sql)?;
    let (id, bound) = row.ok_or_else(|| failure("artifact_unavailable", "生成结果预留已失效"))?;
    if payload.is_empty() || payload.len() > bound as usize || payload.len() > MAX_OUTPUT_BYTES {
        return Err(failure("artifact_too_large", "生成结果超过已预留的大小"));
    }
    let runtime = state.ai_runtime.wallpaper_artifacts.clone();
    if !runtime
        .writers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone())
    {
        return Err(failure("artifact_busy", "生成结果正在写入"));
    }
    let pin = Arc::new(WritePin {
        runtime,
        artifact_id: id.clone(),
    });
    let destination = directory(&root(state)?, &id)?;
    drop(gate);
    tokio::task::spawn_blocking(move || {
        let _pin = pin;
        std::fs::create_dir_all(&destination)
            .map_err(|_| failure("artifact_io", "无法建立生成结果目录"))?;
        let bytes = payload.into_bytes();
        let sha256: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let temporary = destination.join("payload.part");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| failure("artifact_io", "无法建立生成结果暂存文件"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| failure("artifact_io", "生成结果写入未完成"))?;
        drop(file);
        std::fs::rename(temporary, destination.join("payload"))
            .map_err(|_| failure("artifact_io", "生成结果文件提交未完成"))?;
        Ok(Prepared {
            artifact_id: id,
            bytes: bytes.len() as i64,
            sha256,
            _pin,
        })
    })
    .await
    .map_err(|_| internal("生成结果写入任务未完成"))?
}

/// The original execution slot owns this preparation. Cancellation/timeout
/// signals the blocking owner and awaits its exit before returning that slot.
pub(super) async fn prepare_image(
    state: &Arc<AppState>,
    job_id: &str,
    input: super::image_provider::ImageFile,
    request: &WallpaperGenerateRequest,
    deadline: tokio::time::Instant,
    mut cancellation: super::jobs::ProviderCancellation,
) -> ApiResult<Prepared> {
    let gate = tokio::time::timeout_at(deadline, state.ai_runtime.wallpaper_artifacts.gate.lock())
        .await
        .map_err(|_| failure("image_timeout", "图像准备期限已到"))?;
    let row:Option<(String,i64,String)>=tokio::time::timeout_at(deadline,sqlx::query_as("SELECT artifact_id,reserved_bytes,kind FROM ai_wallpaper_artifacts WHERE job_id=? AND state='writing'")
        .bind(job_id).fetch_optional(&state.db)).await.map_err(|_|failure("image_timeout","图像准备期限已到"))?.map_err(sql)?;
    let (id, bound, kind) =
        row.ok_or_else(|| failure("artifact_unavailable", "生成结果预留已失效"))?;
    if kind != "image"
        || bound != hertz_wallpaper::generation::MAX_ARTIFACT_BYTES as i64
        || cancellation.is_cancelled()
        || tokio::time::Instant::now() >= deadline
    {
        return Err(failure("artifact_unavailable", "图像准备资格已失效"));
    }
    let destination = directory(&root(state)?, &id)?;
    if input.workspace.directory != destination {
        return Err(failure("artifact_unavailable", "图像暂存身份不符"));
    }
    let pin = input.workspace.pin.clone();
    let expected = (
        request
            .output
            .width
            .ok_or_else(|| failure("invalid_input", "图像缺少宽度"))?,
        request
            .output
            .height
            .ok_or_else(|| failure("invalid_input", "图像缺少高度"))?,
    );
    drop(gate);
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task_cancel = cancel.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        let _pin = pin;
        let _input = input;
        std::fs::create_dir_all(&destination)
            .map_err(|_| failure("artifact_io", "无法建立结果目录"))?;
        let temporary = destination.join("payload.part");
        let output =
            super::image_prepare::prepare(&_input.path(), &temporary, expected, &task_cancel)
                .map_err(|e| failure(e.code, &e.message))?;
        if output.bytes > bound as u64 || task_cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(failure("image_cancelled", "图像准备已取消"));
        }
        std::fs::rename(temporary, destination.join("payload"))
            .map_err(|_| failure("artifact_io", "图像文件发布未完成"))?;
        Ok(Prepared {
            artifact_id: id,
            bytes: output.bytes as i64,
            sha256: output.sha256,
            _pin,
        })
    });
    let result = tokio::select! {
        result=&mut task=>result,
        _=cancellation.cancelled()=> { cancel.store(true,std::sync::atomic::Ordering::Release); task.await },
        _=tokio::time::sleep_until(deadline)=> { cancel.store(true,std::sync::atomic::Ordering::Release); task.await },
    };
    result.map_err(|_| internal("图像准备任务未完成"))?
}

pub(super) async fn make_available(
    conn: &mut sqlx::SqliteConnection,
    prepared: &Prepared,
    now: i64,
) -> ApiResult<()> {
    let changed = sqlx::query(
        "UPDATE ai_wallpaper_artifacts SET state='available',bytes=?,reserved_bytes=?,sha256=?
        WHERE artifact_id=? AND state='writing' AND expires_at>?",
    )
    .bind(prepared.bytes)
    .bind(prepared.bytes)
    .bind(&prepared.sha256)
    .bind(&prepared.artifact_id)
    .bind(now)
    .execute(conn)
    .await
    .map_err(sql)?
    .rows_affected();
    if changed != 1 {
        return Err(failure("artifact_unavailable", "生成结果提交资格已失效"));
    }
    Ok(())
}

pub(super) async fn reject(state: &Arc<AppState>, job_id: &str, code: &str) {
    if sqlx::query("UPDATE ai_wallpaper_artifacts SET state='rejected',failure_code=? WHERE job_id=? AND state='writing'")
        .bind(code).bind(job_id).execute(&state.db).await.is_err() {
        tracing::warn!("wallpaper artifact failure detail could not be stored");
    }
}

/// Called before admission, after real workers exit, and during startup
/// recovery. Only this store's two fixed files are removed, never user works.
pub(super) async fn cleanup(state: &Arc<AppState>) -> ApiResult<()> {
    let runtime = &state.ai_runtime.wallpaper_artifacts;
    let _gate = runtime.gate.lock().await;
    let now = vmusic_store::now_ms();
    let rows: Vec<(String,String)> = sqlx::query_as(
        "SELECT a.artifact_id,a.state FROM ai_wallpaper_artifacts a JOIN ai_jobs j ON j.job_id=a.job_id
         WHERE a.state IN ('expired','rejected')
          OR (a.state='available' AND a.expires_at<=?)
          OR (a.state='writing' AND j.state IN ('failed','cancelled','interrupted','expired')) LIMIT 500"
    ).bind(now).fetch_all(&state.db).await.map_err(sql)?;
    for (id, state_name) in rows {
        let terminal = if state_name == "writing" || state_name == "rejected" {
            "rejected"
        } else {
            "expired"
        };
        sqlx::query(
            "UPDATE ai_wallpaper_artifacts SET state=? WHERE artifact_id=? AND state!='deleted'",
        )
        .bind(terminal)
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(sql)?;
        if runtime
            .writers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id)
            || runtime
                .readers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id)
        {
            continue;
        }
        let directory = directory(&root(state)?, &id)?;
        let removed = tokio::task::spawn_blocking(move || {
            for name in [
                "payload",
                "payload.part",
                "source.part",
                "wire.part",
                "image.part",
            ] {
                match std::fs::remove_file(directory.join(name)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return false,
                }
            }
            match std::fs::remove_dir(directory) {
                Ok(()) => true,
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
        })
        .await
        .map_err(|_| internal("生成结果清理未完成"))?;
        if removed {
            sqlx::query("UPDATE ai_wallpaper_artifacts SET state='deleted',reserved_bytes=0 WHERE artifact_id=?")
                .bind(id).execute(&state.db).await.map_err(sql)?;
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct ArtifactRow {
    artifact_id: String,
    job_id: String,
    access_principal: String,
    state: String,
    bytes: Option<i64>,
    sha256: Option<String>,
    kind: String,
    mime: String,
    registry_hash: String,
    generation_schema_hash: String,
    expires_at: i64,
    claim_revision: i64,
    failure_code: Option<String>,
}

async fn row(state: &Arc<AppState>, id: &str) -> ApiResult<ArtifactRow> {
    directory(&root(state)?, id)?;
    sqlx::query_as::<_, ArtifactRow>("SELECT * FROM ai_wallpaper_artifacts WHERE artifact_id=?")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(sql)?
        .ok_or_else(|| failure("artifact_unavailable", "生成结果不存在"))
}

async fn authorize(state: &Arc<AppState>, principal: &str, row: &ArtifactRow) -> ApiResult<()> {
    grant_authority(
        state,
        principal,
        &row.access_principal,
        "wallpaper:read_artifact",
    )
    .await?;
    let job = vmusic_store::ai_jobs::find_job_by_id(&state.db, &row.job_id)
        .await
        .map_err(store)?
        .ok_or_else(crate::error::unauthorized)?;
    if job.owner_instance_id != super::jobs::instance_owner(state).await?
        || job.state != "succeeded"
    {
        return Err(failure("artifact_unavailable", "生成结果尚未完成"));
    }
    if row.state != "available" || row.expires_at <= vmusic_store::now_ms() {
        return Err(failure("ai_artifact_expired", "生成结果已到期或删除"));
    }
    Ok(())
}

fn descriptor(row: &ArtifactRow) -> ApiResult<hertz_wallpaper::generation::WallpaperArtifact> {
    use hertz_wallpaper::generation::{WallpaperArtifact, WallpaperGenerationKind};
    let artifact = WallpaperArtifact {
        artifact_id: row.artifact_id.clone(),
        job_id: row.job_id.clone(),
        kind: match row.kind.as_str() {
            "builtin" => WallpaperGenerationKind::Builtin,
            "image" => WallpaperGenerationKind::Image,
            "composition" => WallpaperGenerationKind::Composition,
            _ => return Err(internal("生成结果类别无效")),
        },
        bytes: row.bytes.unwrap_or(0) as u64,
        sha256: row.sha256.clone().unwrap_or_default(),
        mime: row.mime.clone(),
        registry_hash: row.registry_hash.clone(),
        generation_schema_hash: row.generation_schema_hash.clone(),
        expires_at: row.expires_at.to_string(),
    };
    artifact
        .validate()
        .map_err(|_| internal("生成结果信封无效"))?;
    Ok(artifact)
}

pub(crate) async fn job(
    state: &Arc<AppState>,
    principal: &str,
    job_id: &str,
) -> ApiResult<serde_json::Value> {
    let _lifecycle = super::facade::grant_lifecycle().lock().await;
    let id: Option<String> =
        sqlx::query_scalar("SELECT artifact_id FROM ai_wallpaper_artifacts WHERE job_id=?")
            .bind(job_id)
            .fetch_optional(&state.db)
            .await
            .map_err(sql)?;
    let source = vmusic_store::ai_jobs::find_job_by_id(&state.db, job_id)
        .await
        .map_err(store)?
        .filter(|j| j.capability == super::jobs::WALLPAPER_CAPABILITY)
        .ok_or_else(crate::error::unauthorized)?;
    if source.owner_instance_id != super::jobs::instance_owner(state).await? {
        return Err(crate::error::unauthorized());
    }
    let mut value = if let Some(id) = &id {
        let artifact = row(state, id).await?;
        grant_authority(
            state,
            principal,
            &artifact.access_principal,
            "wallpaper:own_job",
        )
        .await?;
        serde_json::to_value(super::jobs::get_job(state, &source.principal, job_id).await?)
    } else {
        grant_authority(state, principal, &source.principal, "wallpaper:own_job").await?;
        serde_json::to_value(super::jobs::get_job(state, principal, job_id).await?)
    }
    .map_err(|_| internal("任务回执无法编码"))?;
    if let Some(id) = id {
        let artifact = row(state, &id).await?;
        value["artifactState"] = serde_json::json!(artifact.state);
        value["claimRevision"] = serde_json::json!(artifact.claim_revision);
        value["artifactFailureCode"] = serde_json::json!(artifact.failure_code);
        if artifact.state == "available" && artifact.expires_at > vmusic_store::now_ms() {
            // A missing immutable file cannot be advertised as downloadable.
            let metadata =
                tokio::fs::metadata(directory(&root(state)?, &id)?.join("payload")).await;
            if metadata.is_ok_and(|m| m.is_file() && Some(m.len() as i64) == artifact.bytes) {
                value["artifact"] = serde_json::to_value(descriptor(&artifact)?)
                    .map_err(|_| internal("结果回执无法编码"))?;
                value["serviceOwner"] = serde_json::json!(source.owner_instance_id);
            }
        }
    }
    Ok(value)
}

struct ReadPin {
    runtime: Arc<Runtime>,
    id: String,
}
impl Drop for ReadPin {
    fn drop(&mut self) {
        let mut readers = self
            .runtime
            .readers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = readers.get_mut(&self.id) {
            *count -= 1;
            if *count == 0 {
                readers.remove(&self.id);
            }
        }
    }
}
struct ReadState {
    file: tokio::fs::File,
    state: Arc<AppState>,
    principal: String,
    id: String,
    remaining: u64,
    deadline: tokio::time::Instant,
    _pin: ReadPin,
}

pub(crate) async fn read(
    state: &Arc<AppState>,
    principal: &str,
    id: &str,
) -> ApiResult<axum::response::Response> {
    use axum::{
        body::Body,
        http::{header, HeaderValue},
        response::IntoResponse,
    };
    let _lifecycle = super::facade::grant_lifecycle().lock().await;
    let runtime = state.ai_runtime.wallpaper_artifacts.clone();
    let _gate = runtime.gate.lock().await;
    let artifact = row(state, id).await?;
    authorize(state, principal, &artifact).await?;
    let descriptor = descriptor(&artifact)?;
    let file = tokio::fs::File::open(directory(&root(state)?, id)?.join("payload"))
        .await
        .map_err(|_| failure("artifact_unavailable", "生成结果文件不可用"))?;
    if file
        .metadata()
        .await
        .map_err(|_| internal("无法检查结果文件"))?
        .len()
        != descriptor.bytes
    {
        return Err(failure("artifact_unavailable", "生成结果文件长度不符"));
    }
    {
        let mut readers = runtime.readers.lock().unwrap_or_else(|e| e.into_inner());
        if readers.values().sum::<usize>() >= 2 {
            return Err(failure(
                "artifact_busy",
                "结果读取槽已占用，请稍后重取同一候选",
            ));
        }
        *readers.entry(id.to_owned()).or_default() += 1;
    }
    let mut reader = ReadState {
        file,
        state: state.clone(),
        principal: principal.into(),
        id: id.into(),
        remaining: descriptor.bytes,
        deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(180),
        _pin: ReadPin {
            runtime: runtime.clone(),
            id: id.into(),
        },
    };
    // A producer deadline runs even when the client stops polling its body.
    // The bounded channel keeps backpressure without pinning files indefinitely.
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let operation = async {
            while reader.remaining > 0 {
                let lifecycle = super::facade::grant_lifecycle().lock().await;
                let artifact = row(&reader.state, &reader.id)
                    .await
                    .map_err(|_| std::io::Error::other("artifact unavailable"))?;
                authorize(&reader.state, &reader.principal, &artifact)
                    .await
                    .map_err(|_| std::io::Error::other("artifact authority expired"))?;
                let mut bytes = vec![0; reader.remaining.min(64 * 1024) as usize];
                let count = reader.file.read(&mut bytes).await?;
                if count == 0 {
                    return Err(std::io::Error::other("artifact truncated"));
                }
                bytes.truncate(count);
                reader.remaining -= count as u64;
                drop(lifecycle);
                sender
                    .send(Some(Ok::<_, std::io::Error>(bytes)))
                    .await
                    .map_err(|_| std::io::Error::other("artifact receiver closed"))?;
            }
            sender
                .send(None)
                .await
                .map_err(|_| std::io::Error::other("artifact receiver closed"))?;
            Ok::<_, std::io::Error>(())
        };
        let deadline = reader.deadline;
        let result = tokio::time::timeout_at(deadline, operation).await;
        if !matches!(result, Ok(Ok(()))) {
            let _ = sender.try_send(Some(Err(std::io::Error::other(
                "artifact stream interrupted",
            ))));
        }
        // Destroy the actual file before refunding its lease, then reclaim.
        let ReadState {
            file, state, _pin, ..
        } = reader;
        // Tokio owns a cloned OS file in a blocking read. Await its actual exit
        // after the client deadline before returning either disk or read quota.
        drop(file.into_std().await);
        drop(_pin);
        if cleanup(&state).await.is_err() {
            tracing::warn!("artifact stream cleanup deferred");
        }
    });
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .flatten()
            .map(|bytes| (bytes, receiver))
    });
    let mut response = Body::from_stream(stream).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(descriptor.bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&descriptor.mime).map_err(|_| internal("结果 MIME 无效"))?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", descriptor.sha256))
            .map_err(|_| internal("结果 hash 无效"))?,
    );
    Ok(response)
}

/// Only the official management router exposes reassignment. The old principal
/// loses access; history and settlement remain attached to the original job.
pub(crate) async fn claim(
    state: &Arc<AppState>,
    id: &str,
    grant_id: &str,
    revision: i64,
) -> ApiResult<serde_json::Value> {
    let _lifecycle = super::facade::grant_lifecycle().lock().await;
    let _gate = state.ai_runtime.wallpaper_artifacts.gate.lock().await;
    let artifact = row(state, id).await?;
    authorize(state, crate::idempotency::LOCAL_OWNER, &artifact).await?;
    let grant = vmusic_store::ai::find_grant_by_id(&state.db, grant_id)
        .await
        .map_err(store)?
        .ok_or_else(crate::error::unauthorized)?;
    super::wallpaper_pairing::validate_grant(state, &grant).await?;
    let scopes: Vec<String> = serde_json::from_str(&grant.scopes).unwrap_or_default();
    if !scopes.iter().any(|s| s == "wallpaper:read_artifact") {
        return Err(crate::error::unauthorized());
    }
    let changed = sqlx::query("UPDATE ai_wallpaper_artifacts SET access_principal=?,claim_revision=claim_revision+1 WHERE artifact_id=? AND state='available' AND claim_revision=? AND expires_at>?")
        .bind(grant_id).bind(id).bind(revision).bind(vmusic_store::now_ms()).execute(&state.db).await.map_err(sql)?.rows_affected();
    if changed != 1 {
        return Err(failure(
            "artifact_claim_changed",
            "结果认领关系已变化，请重新确认",
        ));
    }
    Ok(serde_json::json!({"artifactId":id,"claimRevision":revision+1,"claimed":true}))
}

pub(crate) async fn delete(
    state: &Arc<AppState>,
    principal: &str,
    id: &str,
) -> ApiResult<serde_json::Value> {
    let _lifecycle = super::facade::grant_lifecycle().lock().await;
    {
        let _gate = state.ai_runtime.wallpaper_artifacts.gate.lock().await;
        let artifact = row(state, id).await?;
        authorize(state, principal, &artifact).await?;
        sqlx::query("UPDATE ai_wallpaper_artifacts SET state='rejected' WHERE artifact_id=?")
            .bind(id)
            .execute(&state.db)
            .await
            .map_err(sql)?;
    }
    cleanup(state).await?;
    Ok(serde_json::json!({"deleted":true}))
}

/// One deadline waiter for the original artifact store; no directory polling
/// and no strong AppState reference while idle. New results wake the deadline.
pub(super) fn maintain_retention(state: &Arc<AppState>) {
    use std::sync::atomic::Ordering;
    let runtime = state.ai_runtime.wallpaper_artifacts.clone();
    runtime.retention_wake.notify_one();
    if runtime.retention_started.swap(true, Ordering::AcqRel) {
        return;
    }
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let expiry: Result<Option<i64>, _> = sqlx::query_scalar(
                "SELECT MIN(CASE WHEN state='available' THEN expires_at ELSE ? END) FROM ai_wallpaper_artifacts WHERE state IN ('available','expired','rejected')",
            )
            .bind(vmusic_store::now_ms().saturating_add(60_000))
            .fetch_one(&state.db)
            .await;
            drop(state);
            let expiry = match expiry {
                Ok(expiry) => expiry,
                Err(_) => {
                    tracing::warn!("artifact retention deadline could not be read");
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    continue;
                }
            };
            match expiry {
                None => runtime.retention_wake.notified().await,
                Some(expiry) => {
                    let delay = std::time::Duration::from_millis(
                        expiry.saturating_sub(vmusic_store::now_ms()).max(0) as u64,
                    );
                    tokio::select! { _ = runtime.retention_wake.notified() => continue,
                    _ = tokio::time::sleep(delay) => {} }
                    if let Some(state) = weak.upgrade() {
                        if cleanup(&state).await.is_err() {
                            tracing::warn!("artifact expiry cleanup deferred");
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        }
                    } else {
                        return;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{jobs, wallpaper_jobs};
    use serde_json::json;

    async fn fixture() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!("hertz-artifacts-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir;
        state.ai_runtime = jobs::AiRuntime::from_config(&crate::config::AiConfig {
            image: crate::config::ImageConfig {
                provider: "fake".into(),
                model: "fixture-image-v1".into(),
            },
            ..Default::default()
        });
        state
            .ai_runner_held
            .store(true, std::sync::atomic::Ordering::Relaxed);
        vmusic_store::settings::set(&state.db, "ai_generation_consent", &json!(true))
            .await
            .unwrap();
        (Arc::new(state), audio)
    }
    async fn submit(state: &Arc<AppState>, index: usize) -> ApiResult<jobs::SubmitOutcome> {
        let snapshot = wallpaper_jobs::capability_snapshot(state).await;
        let request_id = format!("artifact-{index}");
        let body = json!({"version":1,"requestId":request_id,"brief":"宁静夜色",
            "output":{"kind":"builtin","sceneId":"coast"},"registryHash":snapshot.registry_hash,
            "generationSchemaHash":snapshot.generation_schema_hash,"capabilitySnapshotId":snapshot.snapshot_id});
        let principal = crate::idempotency::LOCAL_OWNER;
        let quote =
            jobs::wallpaper_quote(state, principal, &serde_json::to_vec(&body).unwrap()).await?;
        let result = jobs::wallpaper_submit(
            state,
            principal,
            quote["quoteId"].as_str().unwrap(),
            &request_id,
            None,
        )
        .await;
        state.ai_runtime.discard_wallpaper_quotes(principal).await;
        result
    }
    async fn terminal(state: &Arc<AppState>, id: &str) -> vmusic_store::ai_jobs::JobRow {
        for _ in 0..1000 {
            let row = vmusic_store::ai_jobs::find_job_by_id(&state.db, id)
                .await
                .unwrap()
                .unwrap();
            if !matches!(row.state.as_str(), "accepted" | "running") {
                return row;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("fixture task did not terminate");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn image_sources_use_the_original_recovery_record_and_actual_writer_pin() {
        let (state, audio) = fixture().await;
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(terminal(&state, &accepted.job_id).await.state, "succeeded");
        while state.ai_runtime.has_input(&accepted.job_id).await {
            tokio::task::yield_now().await;
        }
        // Simulate the fixed source files left by a crashed image execution.
        sqlx::query("UPDATE ai_wallpaper_artifacts SET kind='image',mime='image/png',state='writing',reserved_bytes=33554432 WHERE job_id=?")
            .bind(&accepted.job_id).execute(&state.db).await.unwrap();
        let workspace = image_workspace(
            &state,
            &accepted.job_id,
            tokio::time::Instant::now() + std::time::Duration::from_secs(2),
        )
        .await
        .unwrap();
        for name in ["source.part", "wire.part", "image.part"] {
            std::fs::write(workspace.directory.join(name), b"orphaned source").unwrap();
        }
        sqlx::query(
            "UPDATE ai_jobs SET state='interrupted',state_revision=state_revision+1 WHERE job_id=?",
        )
        .bind(&accepted.job_id)
        .execute(&state.db)
        .await
        .unwrap();
        cleanup(&state).await.unwrap();
        assert!(
            workspace.directory.join("source.part").is_file(),
            "actual I/O pin protects cancellation cleanup"
        );
        let path = workspace.directory.clone();
        drop(workspace);
        cleanup(&state).await.unwrap();
        assert!(!path.exists());
        let capacity: i64 =
            sqlx::query_scalar("SELECT reserved_bytes FROM ai_wallpaper_artifacts WHERE job_id=?")
                .bind(&accepted.job_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(capacity, 0);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn image_workspace_deadline_covers_database_pool_wait_before_any_file_creation() {
        let (state, audio) = fixture().await;
        let mut held = Vec::new();
        for _ in 0..state.db.options().get_max_connections() {
            held.push(state.db.acquire().await.unwrap());
        }
        let result = image_workspace(
            &state,
            "no-job",
            tokio::time::Instant::now() + std::time::Duration::from_millis(20),
        )
        .await;
        assert_eq!(result.err().unwrap().code, "image_timeout");
        assert!(!root(&state).unwrap().exists());
        drop(held);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn image_uses_original_job_and_artifact_transaction_and_full_free_vector() {
        let (state, audio) = fixture().await;
        let snapshot = wallpaper_jobs::capability_snapshot(&state).await;
        let body = json!({"version":1,"requestId":"image-fixture","brief":"离线图片",
            "output":{"kind":"image","width":1024,"height":1024,"qualityId":"fixture"},
            "registryHash":snapshot.registry_hash,"generationSchemaHash":snapshot.generation_schema_hash,"capabilitySnapshotId":snapshot.snapshot_id});
        let principal = crate::idempotency::LOCAL_OWNER;
        let quote = jobs::wallpaper_quote(&state, principal, &serde_json::to_vec(&body).unwrap())
            .await
            .unwrap();
        assert_eq!(quote["pricingMode"], "free");
        assert_eq!(quote["executionSeconds"], 180);
        assert_eq!(quote["dimensions"][2]["dimension"], "imageOutput");
        let key = format!(
            "v1.{}.{}",
            vmusic_store::now_ms(),
            uuid::Uuid::new_v4().simple()
        );
        let jobs::SubmitOutcome::Accepted { job: accepted } = jobs::wallpaper_submit(
            &state,
            principal,
            quote["quoteId"].as_str().unwrap(),
            "image-fixture",
            Some(&key),
        )
        .await
        .unwrap() else {
            panic!()
        };
        let row = terminal(&state, &accepted.job_id).await;
        assert_eq!(row.state, "succeeded");
        assert_eq!(row.run_deadline_ms, 180_000);
        assert_eq!(row.reservation_limit_micro_usd, 500_000);
        let artifact = job(&state, principal, &accepted.job_id).await.unwrap();
        assert_eq!(artifact["artifact"]["kind"], "image");
        assert_eq!(artifact["artifact"]["mime"], "image/png");
        let id = artifact["artifact"]["artifactId"].as_str().unwrap();
        let path = root(&state).unwrap().join(id).join("payload");
        let probe =
            hertz_wallpaper::media::probe(&mut std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!((probe.encoded_width, probe.encoded_height), (1024, 1024));
        let (bytes, hash) = hertz_wallpaper::image_prepare::hash(&path).unwrap();
        assert_eq!(artifact["artifact"]["bytes"], bytes);
        assert_eq!(artifact["artifact"]["sha256"], hash);
        let usage = loop {
            if let Some(usage) =
                vmusic_store::ai_jobs::find_usage_entry(&state.db, &accepted.job_id)
                    .await
                    .unwrap()
            {
                break usage;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        assert_eq!(usage.accounted_micro_usd, 0);
        let reported: super::super::usage::TrustedUsage =
            serde_json::from_str(usage.reported_usage.as_deref().unwrap()).unwrap();
        assert!(reported.metering.is_some());
        state.audio.shutdown();
        audio.join().unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn result_quota_is_reserved_before_a_ninth_provider_call_and_expiry_releases_it() {
        let (state, audio) = fixture().await;
        let mut ids = Vec::new();
        for index in 0..8 {
            let jobs::SubmitOutcome::Accepted { job } = submit(&state, index).await.unwrap() else {
                panic!();
            };
            assert_eq!(terminal(&state, &job.job_id).await.state, "succeeded");
            ids.push(job.job_id);
        }
        let error = submit(&state, 8).await.unwrap_err();
        assert_eq!(error.code, "artifact_capacity_exceeded");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(
            count, 8,
            "failed admission must roll back its task and reservation"
        );
        let artifact: String =
            sqlx::query_scalar("SELECT artifact_id FROM ai_wallpaper_artifacts WHERE job_id=?")
                .bind(&ids[0])
                .fetch_one(&state.db)
                .await
                .unwrap();
        let payload = root(&state).unwrap().join(&artifact).join("payload");
        assert!(payload.is_file());
        sqlx::query("UPDATE ai_wallpaper_artifacts SET expires_at=0 WHERE artifact_id=?")
            .bind(&artifact)
            .execute(&state.db)
            .await
            .unwrap();
        cleanup(&state).await.unwrap();
        assert!(!payload.exists());
        let row: (String, i64) = sqlx::query_as(
            "SELECT state,reserved_bytes FROM ai_wallpaper_artifacts WHERE artifact_id=?",
        )
        .bind(&artifact)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(row, ("deleted".into(), 0));
        let jobs::SubmitOutcome::Accepted { job } = submit(&state, 9).await.unwrap() else {
            panic!();
        };
        assert_eq!(terminal(&state, &job.job_id).await.state, "succeeded");
        state.audio.shutdown();
        audio.join().unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sized_result_stream_pins_capacity_until_both_real_readers_exit() {
        let (state, audio) = fixture().await;
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(terminal(&state, &accepted.job_id).await.state, "succeeded");
        let principal = crate::idempotency::LOCAL_OWNER;
        let view = job(&state, principal, &accepted.job_id).await.unwrap();
        let metadata = hertz_wallpaper::generation::WallpaperArtifact::parse(
            &serde_json::to_vec(&view["artifact"]).unwrap(),
        )
        .unwrap();
        assert!(job(&state, "another-owner", &accepted.job_id)
            .await
            .is_err());
        assert!(read(&state, "another-owner", &metadata.artifact_id)
            .await
            .is_err());
        let first = read(&state, principal, &metadata.artifact_id)
            .await
            .unwrap();
        let second = read(&state, principal, &metadata.artifact_id)
            .await
            .unwrap();
        assert_eq!(
            read(&state, principal, &metadata.artifact_id)
                .await
                .unwrap_err()
                .code,
            "artifact_busy"
        );
        let bytes = axum::body::to_bytes(first.into_body(), 64 * 1024)
            .await
            .unwrap();
        assert_eq!(bytes.len() as u64, metadata.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), metadata.sha256);
        let path = root(&state)
            .unwrap()
            .join(&metadata.artifact_id)
            .join("payload");
        delete(&state, principal, &metadata.artifact_id)
            .await
            .unwrap();
        assert!(
            path.is_file(),
            "an unconsumed real body still owns its file lease"
        );
        assert!(read(&state, principal, &metadata.artifact_id)
            .await
            .is_err());
        drop(second);
        for _ in 0..1000 {
            if !state
                .ai_runtime
                .wallpaper_artifacts
                .readers
                .lock()
                .unwrap()
                .contains_key(&metadata.artifact_id)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        cleanup(&state).await.unwrap();
        assert!(!path.exists());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_payload_is_not_advertised_after_success_or_recovery() {
        let (state, audio) = fixture().await;
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        terminal(&state, &accepted.job_id).await;
        let view = job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
            .await
            .unwrap();
        let id = view["artifact"]["artifactId"].as_str().unwrap();
        std::fs::remove_file(root(&state).unwrap().join(id).join("payload")).unwrap();
        jobs::recover(&state).await.unwrap();
        let view = job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
            .await
            .unwrap();
        assert!(view["artifact"].is_null());
        assert!(read(&state, crate::idempotency::LOCAL_OWNER, id)
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 1, "recovery must never submit the provider again");
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn file_failure_never_commits_a_success_and_keeps_verified_usage() {
        let (state, audio) = fixture().await;
        let slot = state
            .ai_runtime
            .completion_slots()
            .acquire_owned()
            .await
            .unwrap();
        let jobs::SubmitOutcome::Accepted { job } = submit(&state, 0).await.unwrap() else {
            panic!();
        };
        let id: String =
            sqlx::query_scalar("SELECT artifact_id FROM ai_wallpaper_artifacts WHERE job_id=?")
                .bind(&job.job_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        let destination = root(&state).unwrap().join(id);
        std::fs::create_dir_all(destination.join("payload.part")).unwrap();
        drop(slot);
        let row = terminal(&state, &job.job_id).await;
        assert_eq!(row.state, "failed");
        assert_eq!(row.failure_code.as_deref(), Some("internal_error"));
        let code: String =
            sqlx::query_scalar("SELECT failure_code FROM ai_wallpaper_artifacts WHERE job_id=?")
                .bind(&job.job_id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(code, "artifact_io");
        assert!(row.result_proposal_id.is_none());
        assert!(!destination.join("payload").exists());
        for _ in 0..1000 {
            if vmusic_store::ai_jobs::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let usage = vmusic_store::ai_jobs::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.accounted_micro_usd, 0);
        assert!(usage.reported_usage.is_some());
        for _ in 0..1000 {
            if !state.ai_runtime.has_input(&job.job_id).await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            !state.ai_runtime.has_input(&job.job_id).await,
            "a failed writer cannot retain the brief or cancellation sender"
        );
        // This fixture created the unexpected directory; the store refuses to
        // recursively delete it. Clear only that fixture directory, then retry.
        std::fs::remove_dir(destination.join("payload.part")).unwrap();
        cleanup(&state).await.unwrap();
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn result_transaction_failure_rolls_back_availability_and_preserves_usage() {
        let (state, audio) = fixture().await;
        let slot = state
            .ai_runtime
            .completion_slots()
            .acquire_owned()
            .await
            .unwrap();
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        // The real worker publishes its file, then this SQLite fault rejects
        // the result transaction. Neither success nor availability may escape.
        sqlx::query("CREATE TRIGGER reject_fixture_result BEFORE UPDATE OF state ON ai_wallpaper_artifacts WHEN NEW.state='available' BEGIN SELECT RAISE(ABORT,'fixture result commit failure'); END")
            .execute(&state.db).await.unwrap();
        drop(slot);
        let result = terminal(&state, &accepted.job_id).await;
        assert_eq!(result.state, "failed");
        assert!(result.result_proposal_id.is_none());
        let advertised = job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
            .await
            .unwrap();
        assert!(advertised["artifact"].is_null());
        let available: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_wallpaper_artifacts WHERE state='available'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(available, 0);
        for _ in 0..1000 {
            if vmusic_store::ai_jobs::find_usage_entry(&state.db, &accepted.job_id)
                .await
                .unwrap()
                .is_some()
                && !state.ai_runtime.has_input(&accepted.job_id).await
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let usage = vmusic_store::ai_jobs::find_usage_entry(&state.db, &accepted.job_id)
            .await
            .unwrap()
            .unwrap();
        assert!(usage.reported_usage.is_some());
        assert_eq!(usage.accounted_micro_usd, 0);
        assert!(!state.ai_runtime.has_input(&accepted.job_id).await);
        jobs::recover(&state).await.unwrap();
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(remaining, 1, "recovery must not submit the provider again");
        let retained: i64 =
            sqlx::query_scalar("SELECT SUM(reserved_bytes) FROM ai_wallpaper_artifacts")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            retained, 0,
            "failed result files must release capacity after cleanup"
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retention_deadline_reclaims_without_an_admission_or_job_poll() {
        let (state, audio) = fixture().await;
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        terminal(&state, &accepted.job_id).await;
        let result = job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
            .await
            .unwrap();
        let id = result["artifact"]["artifactId"].as_str().unwrap();
        let path = root(&state).unwrap().join(id).join("payload");
        sqlx::query("UPDATE ai_wallpaper_artifacts SET expires_at=? WHERE artifact_id=?")
            .bind(vmusic_store::now_ms() + 50)
            .bind(id)
            .execute(&state.db)
            .await
            .unwrap();
        maintain_retention(&state);
        for _ in 0..1000 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            !path.exists(),
            "the owned deadline must reclaim idle results"
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn descriptor_and_claim_revalidate_live_scope_and_serialize_with_revocation() {
        use hertz_desktop_ipc::{
            windows::{process_generation, Identity},
            Profile,
        };
        use hertz_wallpaper::pairing;
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let (state, audio) = fixture().await;
        let identity = Identity::current().unwrap();
        let profile = Profile::Standalone {
            edition: crate::edition::NAME.into(),
            data_dir: state.data_dir.to_string_lossy().into_owned(),
        }
        .normalized()
        .unwrap();
        let binding = pairing::Binding {
            protocol: pairing::PROTOCOL,
            user_sid: identity.user_sid,
            windows_session_id: identity.windows_session_id,
            native_pid: child.id(),
            native_generation: process_generation(child.id()).unwrap(),
            desktop_build_id: "c".repeat(64),
            edition: crate::edition::NAME.into(),
            profile_digest: pairing::profile_digest(profile.edition(), profile.data_dir()),
            service_pid: std::process::id(),
            server_instance_id: state.server_instance_id.clone(),
        };
        let owner = super::super::jobs::instance_owner(&state).await.unwrap();
        let grant = uuid::Uuid::new_v4().to_string();
        vmusic_store::ai::insert_session_grant(&state.db,&grant,&"a".repeat(64),&serde_json::to_string(pairing::SCOPES).unwrap(),&json!({"binding":binding,"ownerInstanceId":owner,"expiresAt":vmusic_store::now_ms()+pairing::SESSION_MS}).to_string()).await.unwrap();
        state
            .ai_runtime
            .wallpaper_session_deadlines
            .lock()
            .await
            .insert(
                grant.clone(),
                std::time::Instant::now()
                    + std::time::Duration::from_millis(pairing::SESSION_MS as u64),
            );
        let jobs::SubmitOutcome::Accepted { job: accepted } = submit(&state, 0).await.unwrap()
        else {
            panic!()
        };
        terminal(&state, &accepted.job_id).await;
        let official = job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
            .await
            .unwrap();
        let id = official["artifact"]["artifactId"]
            .as_str()
            .unwrap()
            .to_owned();
        let revision = official["claimRevision"].as_i64().unwrap();
        let claimed = claim(&state, &id, &grant, revision).await.unwrap();
        assert!(job(&state, &grant, &accepted.job_id).await.is_ok());
        let response = read(&state, &grant, &id).await.unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        assert_eq!(
            bytes.len() as u64,
            official["artifact"]["bytes"].as_u64().unwrap()
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            official["artifact"]["sha256"].as_str().unwrap()
        );
        let next_revision = claimed["claimRevision"].as_i64().unwrap();
        let original_binding: String =
            sqlx::query_scalar("SELECT session_binding FROM ai_grants WHERE grant_id=?")
                .bind(&grant)
                .fetch_one(&state.db)
                .await
                .unwrap();
        // The business entrypoints must reread authority, even if the caller
        // presents a previously valid principal or claim revision.
        let without_read: Vec<_> = pairing::SCOPES
            .iter()
            .copied()
            .filter(|scope| *scope != "wallpaper:read_artifact")
            .collect();
        sqlx::query("UPDATE ai_grants SET scopes=? WHERE grant_id=?")
            .bind(serde_json::to_string(&without_read).unwrap())
            .bind(&grant)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            job(&state, &grant, &accepted.job_id).await.is_ok(),
            "task summaries retain their independent own_job scope"
        );
        assert!(read(&state, &grant, &id).await.is_err());
        assert!(claim(&state, &id, &grant, next_revision).await.is_err());
        sqlx::query("UPDATE ai_grants SET scopes='[]' WHERE grant_id=?")
            .bind(&grant)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(job(&state, &grant, &accepted.job_id).await.is_err());
        sqlx::query("UPDATE ai_grants SET scopes=? WHERE grant_id=?")
            .bind(serde_json::to_string(pairing::SCOPES).unwrap())
            .bind(&grant)
            .execute(&state.db)
            .await
            .unwrap();
        for field in ["ownerInstanceId", "nativeGeneration"] {
            let mut invalid: serde_json::Value = serde_json::from_str(&original_binding).unwrap();
            if field == "nativeGeneration" {
                invalid["binding"][field] = json!("retired-process");
            } else {
                invalid[field] = json!("another-service-owner");
            }
            sqlx::query("UPDATE ai_grants SET session_binding=? WHERE grant_id=?")
                .bind(invalid.to_string())
                .bind(&grant)
                .execute(&state.db)
                .await
                .unwrap();
            assert!(
                job(&state, &grant, &accepted.job_id).await.is_err(),
                "{field}"
            );
            assert!(read(&state, &grant, &id).await.is_err(), "{field}");
            assert!(
                claim(&state, &id, &grant, next_revision).await.is_err(),
                "{field}"
            );
        }
        sqlx::query("UPDATE ai_grants SET session_binding=? WHERE grant_id=?")
            .bind(&original_binding)
            .bind(&grant)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(job(&state, &grant, &accepted.job_id).await.is_ok());
        // Revocation owns the canonical lifecycle lock. A claim must wait
        // there, then reread the revoked grant before changing artifact access.
        let lifecycle = super::super::facade::grant_lifecycle().lock().await;
        let claim_state = state.clone();
        let claim_id = id.clone();
        let claim_grant = grant.clone();
        let mut claiming = tokio::spawn(async move {
            claim(&claim_state, &claim_id, &claim_grant, next_revision).await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut claiming)
                .await
                .is_err()
        );
        vmusic_store::ai::revoke_grant(&state.db, &grant)
            .await
            .unwrap();
        drop(lifecycle);
        assert!(claiming.await.unwrap().is_err());
        assert!(job(&state, &grant, &accepted.job_id).await.is_err());
        assert!(read(&state, &grant, &id).await.is_err());
        assert!(claim(&state, &id, &grant, next_revision).await.is_err());
        assert!(
            job(&state, crate::idempotency::LOCAL_OWNER, &accepted.job_id)
                .await
                .is_ok()
        );
        child.kill().unwrap();
        child.wait().unwrap();
        state.audio.shutdown();
        audio.join().unwrap();
    }
}
