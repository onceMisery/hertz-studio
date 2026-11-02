// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 导入任务管理（设计 docs/desktop-wallpaper.md §7.1/§12.1）。
//!
//! 资源准备任务全局一个：同一时刻最多一个活动导入，槽被占时立即返回
//! `budget_busy`（有界等待由调用方决定），不排队大任务。取消只作废代际；
//! 真实 I/O 退出并归还槽之后，任务才算终结（§7.1：「取消后先作废 job
//! generation，待真实 I/O/解码退出才归还槽，不能提前接受第二个大任务」）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use thiserror::Error;

use crate::wallpaper::assets::AssetStore;
use crate::wallpaper::decode_probe::ProbeClient;
use crate::wallpaper::library::{Library, LOCAL_SOURCE};

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

impl JobError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }
    pub fn database(message: impl Into<String>) -> Self {
        Self::new("database", message)
    }
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }
    pub fn hash_conflict(message: impl Into<String>) -> Self {
        Self::new("version_hash_conflict", message)
    }
}

impl From<hertz_wallpaper::PackageError> for JobError {
    fn from(error: hertz_wallpaper::PackageError) -> Self {
        Self::new("package_invalid", format!("{error}"))
    }
}

/// 任务状态机（§7.1 Probe/Prepare/Install 三阶段 + 终态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Preparing,
    Publishing,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub job_id: String,
    pub state: JobState,
    pub error: Option<String>,
    pub package_hash: Option<String>,
    pub staged_bytes: u64,
    pub generation: u64,
}

struct ActiveJob {
    status: Arc<Mutex<JobStatus>>,
    cancel: Arc<AtomicBool>,
}

struct Inner {
    current: Option<ActiveJob>,
    history: std::collections::VecDeque<JobStatus>,
}

impl Inner {
    fn remember(&mut self, status: JobStatus) {
        self.history.push_back(status);
        while self.history.len() > 32 {
            self.history.pop_front();
        }
    }
}

/// 导入任务管理器：单槽 worker 线程（current_thread runtime 跑 sqlx）。
pub struct ImportJobs {
    inner: Arc<Mutex<Inner>>,
    submit_tx: tokio::sync::mpsc::Sender<JobRequest>,
    generation: Arc<AtomicU64>,
    library: Arc<Library>,
    assets: Arc<AssetStore>,
}

struct JobRequest {
    job_id: String,
    source: PathBuf,
    status: Arc<Mutex<JobStatus>>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    target: Option<super::image_prepare::ImageTarget>,
}

impl ImportJobs {
    /// 启动 worker。`library` 与 `assets` 的所有权共享给任务管线。
    pub fn start(library: Library, assets: AssetStore, probe: ProbeClient) -> Self {
        let library = Arc::new(library);
        let assets = Arc::new(assets);
        // 容量 1：受理即入队；并发受 inner.current 单槽标记约束（busy 即拒）。
        let (tx, rx) = tokio::sync::mpsc::channel::<JobRequest>(1);
        let inner = Arc::new(Mutex::new(Inner {
            current: None,
            history: std::collections::VecDeque::new(),
        }));
        let worker_inner = inner.clone();
        let worker_library = library.clone();
        let worker_assets = assets.clone();
        std::thread::Builder::new()
            .name("hertz-wallpaper-import".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => return,
                };
                runtime.block_on(worker_loop(
                    rx,
                    worker_inner,
                    worker_library,
                    worker_assets,
                    probe,
                ));
            })
            .expect("create wallpaper import thread");
        Self {
            inner,
            submit_tx: tx,
            generation: Arc::new(AtomicU64::new(1)),
            library,
            assets,
        }
    }

    pub(crate) fn library(&self) -> &Library {
        &self.library
    }

    pub(crate) fn assets(&self) -> &AssetStore {
        &self.assets
    }

    /// 受理一个导入。只接受源路径由本机文件对话框产生（fileToken 的解析在
    /// P1-05 管理层；内核层只见本进程拥有的路径）。
    /// 槽占用返回 `budget_busy`；受理立即返回 jobId（§7.1）。
    pub fn submit(&self, job_id: String, source: PathBuf) -> Result<String, JobError> {
        self.submit_for_target(job_id, source, None)
    }

    /// 使用已规划的目标像素准备图片；与普通导入共用槽、取消及原子发布流程。
    pub(crate) fn submit_for_target(
        &self,
        job_id: String,
        source: PathBuf,
        target: Option<super::image_prepare::ImageTarget>,
    ) -> Result<String, JobError> {
        super::image_prepare::validate_target(target)?;
        if job_id.is_empty()
            || job_id.len() > 64
            || !job_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(JobError::invalid_input("jobId 必须是有界的单个目录名"));
        }
        if !source.is_file() {
            return Err(JobError::invalid_input(format!(
                "导入源不存在或不是文件：{}",
                source.display()
            )));
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let status = Arc::new(Mutex::new(JobStatus {
            job_id: job_id.clone(),
            state: JobState::Queued,
            error: None,
            package_hash: None,
            staged_bytes: 0,
            generation,
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self.inner.lock().expect("job inner");
            if guard.current.is_some() {
                return Err(JobError::new(
                    "budget_busy",
                    "已有导入任务在执行，请等待完成或取消",
                ));
            }
            guard.current = Some(ActiveJob {
                status: status.clone(),
                cancel: cancel.clone(),
            });
        }
        let request = JobRequest {
            job_id: job_id.clone(),
            source,
            status,
            cancel,
            generation,
            target,
        };
        // 槽已在 inner 标记占用；若 worker 已死导致投递失败，这里同步归还槽。
        if self.submit_tx.try_send(request).is_err() {
            let mut guard = self.inner.lock().expect("job inner");
            guard.current = None;
            return Err(JobError::new("budget_busy", "导入槽暂不可用"));
        }
        Ok(job_id)
    }

    /// 取消当前任务：只置取消代际；真实 I/O 退出后才还槽（§7.1）。
    pub fn cancel(&self, job_id: &str) {
        let guard = self.inner.lock().expect("job inner");
        if let Some(job) = guard.current.as_ref() {
            let running_id = job.status.lock().expect("status").job_id.clone();
            if running_id == job_id {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
    }

    /// 查询任务状态：活动任务优先，其次近期历史（内存去重表，有界）。
    pub fn status(&self, job_id: &str) -> Option<JobStatus> {
        self.latest_status_of(job_id)
    }

    fn latest_status_of(&self, job_id: &str) -> Option<JobStatus> {
        let guard = self.inner.lock().expect("job inner");
        if let Some(job) = guard.current.as_ref() {
            let status = job.status.lock().expect("status").clone();
            if status.job_id == job_id {
                return Some(status);
            }
        }
        guard
            .history
            .iter()
            .rev()
            .find(|status| status.job_id == job_id)
            .cloned()
    }
}

async fn worker_loop(
    mut rx: tokio::sync::mpsc::Receiver<JobRequest>,
    inner: Arc<Mutex<Inner>>,
    library: Arc<Library>,
    assets: Arc<AssetStore>,
    probe: ProbeClient,
) {
    // 等任务时必须继续驱动 runtime：sqlx 的连接归还也会投递异步任务。
    // 在 current_thread runtime 内阻塞 recv 会把空闲连接卡住，查询最终池超时。
    while let Some(request) = rx.recv().await {
        let outcome = match assets.content_writer() {
            Ok(writer) => {
                let preparation =
                    probe.prepare(format!("prepare-{}-{}", request.job_id, request.generation));
                let outcome = match preparation.as_ref() {
                    Ok(_) => run_import(&request, &library, &assets, &probe, &writer).await,
                    Err(error) => Err(JobError::new(error.code, error.message.clone())),
                };
                // 写门保持到物理退出、暂存清理和准备额度归还，失败者不清理其它写者的 job。
                assets.cleanup_staging(&request.job_id);
                if let Ok(preparation) = preparation {
                    preparation.finish();
                }
                outcome
            }
            Err(error) => Err(error),
        };
        let mut status = request.status.lock().expect("status").clone();
        match outcome {
            Ok(package_hash) => {
                status.state = JobState::Done;
                status.package_hash = Some(package_hash);
            }
            Err(error) if error.code == "cancelled" => {
                status.state = JobState::Cancelled;
                status.error = Some(error.message);
            }
            Err(error) => {
                status.state = JobState::Failed;
                status.error = Some(format!("{}: {}", error.code, error.message));
            }
        }
        let _ = library
            .record_job(
                &status.job_id,
                None,
                job_state_db(&status.state),
                None,
                Some(&format!("{}", status.staged_bytes)),
                status.error.as_deref(),
            )
            .await;
        {
            let mut guard = inner.lock().expect("job inner");
            guard.remember(status.clone());
            guard.current = None;
        }
    }
}

fn job_state_db(state: &JobState) -> &'static str {
    match state {
        JobState::Queued => "queued",
        JobState::Preparing => "preparing",
        JobState::Publishing => "publishing",
        JobState::Done => "done",
        JobState::Failed => "failed",
        JobState::Cancelled => "cancelled",
    }
}

fn set_state(status: &Arc<Mutex<JobStatus>>, state: JobState) {
    let mut guard = status.lock().expect("status");
    guard.state = state;
}

fn set_stage_bytes(status: &Arc<Mutex<JobStatus>>, staged_bytes: u64) {
    let mut guard = status.lock().expect("status");
    guard.staged_bytes = staged_bytes;
}

fn cancelled(cancel: &AtomicBool) -> Result<(), JobError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(JobError::new("cancelled", "导入已被取消"));
    }
    Ok(())
}

/// §7.1 导入管线：固定快照 → 包校验/解包 → 容器/像素及真实首帧/seek →
/// controller 与流物理退出 → 原子发布 → DB 事务。重复导入也复核当前解码环境。
async fn run_import(
    request: &JobRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    writer: &super::content_quota::Writer<'_>,
) -> Result<String, JobError> {
    let _ = library
        .record_job(&request.job_id, None, "preparing", None, None, None)
        .await;
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    // 单个后台准备槽中做缓存恢复与清理；没有定时轮询，也不在 UI/帧路径扫盘。
    super::derived_cache::Writer::acquire(assets)?
        .reclaim(library, 0, super::derived_cache::CAP)
        .await?;
    // ① Probe（文件侧）：独占句柄快照，后续只读这份固定输入。
    let receipt = assets.snapshot_input(&request.job_id, &request.source, Some(&request.cancel))?;
    set_stage_bytes(&request.status, receipt.bytes);
    cancelled(&request.cancel)?;
    // ② Prepare：对固定快照做包校验（结构/路径/哈希），取 manifest 事实。
    let package = assets.validate_staged(&request.job_id)?;
    if package.package_hash != receipt.sha256 {
        return Err(JobError::new(
            "hash_mismatch",
            format!(
                "快照哈希 {} 与校验器计算的 {} 不一致",
                receipt.sha256, package.package_hash
            ),
        ));
    }
    let content_kind = match &package.manifest.content {
        hertz_wallpaper::manifest::Content::Image { .. } => "image",
        hertz_wallpaper::manifest::Content::Video { .. } => "video",
        hertz_wallpaper::manifest::Content::Builtin { .. } => "builtin",
        hertz_wallpaper::manifest::Content::Composition { .. } => "composition",
        hertz_wallpaper::manifest::Content::Web { .. } => "web",
    }
    .to_string();
    // ③ 配额预检：既有同 hash 只核对安全目录，不重复申请持久容量。
    writer.preflight(&request.job_id, &package)?;
    // 去重：相同 hash 已安装 → 不再发布第二份物理包，幂等返回既有事实。
    if library.is_installed(&package.package_hash).await?
        && assets.verify_installed(&package.package_hash)?.is_some()
    {
        let mut prepared = qualify_media(
            request,
            library,
            assets,
            probe,
            assets.probe_installed_media(&package, &request.cancel)?,
        )
        .await?;
        cancelled(&request.cancel)?;
        for image in &mut prepared {
            image.publish(assets, library).await?;
        }
        library.mark_available(&package.package_hash).await?;
        return Ok(package.package_hash.clone());
    }
    // ④ 空间峰值预检；现有 staging 已从实际可用空间扣除。
    let projection_bytes: u64 = package.manifest.files.iter().map(|file| file.bytes).sum();
    assets.check_disk_space(projection_bytes)?;
    // ⑤ 投影解包（files/ 只含已声明路径）。
    assets.unpack_projection(&request.job_id, &package)?;
    let mut prepared = qualify_media(
        request,
        library,
        assets,
        probe,
        assets.probe_staged_media(&request.job_id, &package, &request.cancel)?,
    )
    .await?;
    cancelled(&request.cancel)?;
    // ⑥ Install：flush → 原子改名到 packageHash 目录（拒绝覆盖）。
    set_state(&request.status, JobState::Publishing);
    for image in &mut prepared {
        image.publish(assets, library).await?;
    }
    // 所有派生代际已移出，空的准备目录不进入不可变原包投影。
    let derived = assets.staging_dir(&request.job_id).join("derived");
    if derived.exists() {
        std::fs::remove_dir_all(derived).map_err(|error| JobError::io(error.to_string()))?;
    }
    match writer.publish_staging(&request.job_id, &package.package_hash) {
        Ok(()) => {}
        Err(error) if error.code == "target_exists" => {
            // 目录已存在但未索引：崩溃恢复语义覆盖它；本任务按重复处理。
            let existing = assets.verify_installed(&package.package_hash)?;
            if existing.is_none() {
                return Err(JobError::new(
                    "target_exists",
                    format!(
                        "包目录 {} 已存在但不可核验，等待启动恢复",
                        package.package_hash
                    ),
                ));
            }
        }
        Err(error) => return Err(error),
    };
    // ⑦ 新发布和核验通过的孤立目录都必须完成索引事务。
    library
        .install(&crate::wallpaper::library::InstallWork {
            remote_work_id: package.manifest.work_id.clone(),
            work_key: format!("local-{}", package.manifest.work_id),
            title: package.manifest.title.clone(),
            description: package.manifest.description.clone(),
            kind: content_kind,
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json.clone(),
            package_bytes: receipt.bytes,
            version: package.manifest.version,
            source_id: LOCAL_SOURCE.into(),
        })
        .await?;
    Ok(package.package_hash)
}

async fn qualify_media(
    request: &JobRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    inputs: Vec<super::assets::DecodeInput>,
) -> Result<Vec<super::image_prepare::PreparedImage>, JobError> {
    let mut prepared: Vec<super::image_prepare::PreparedImage> = Vec::new();
    for input in inputs {
        cancelled(&request.cancel)?;
        if input.metadata.container == super::media::Container::Image {
            if let Some(image) = prepared
                .iter()
                .find(|image| image.receipt.input_hash == input.media.entry.sha256)
            {
                probe
                    .qualify(
                        library,
                        image.decode_input(assets, &input)?,
                        Arc::clone(&request.cancel),
                    )
                    .await?;
            } else {
                let image = super::image_prepare::prepare(
                    assets,
                    library,
                    probe,
                    &request.job_id,
                    &input,
                    request.target,
                    &request.cancel,
                )
                .await?;
                probe
                    .qualify(
                        library,
                        image.decode_input(assets, &input)?,
                        Arc::clone(&request.cancel),
                    )
                    .await?;
                prepared.push(image);
            }
        } else {
            probe
                .qualify(library, input, Arc::clone(&request.cancel))
                .await?;
        }
    }
    Ok(prepared)
}

/// 启动恢复（§7.2）：目录在索引缺 → 核验后恢复入库；索引在目录缺 → unavailable。
/// 崩溃恢复不自动启用任何作品（启用意图在 config 域）。
pub async fn reconcile_startup(library: &Library, assets: &AssetStore) -> Result<(), JobError> {
    let _writer = assets.content_writer()?;
    let indexed = library.installed_packages().await?;
    let mut indexed_hashes: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in indexed {
        indexed_hashes.insert(row.package_hash.clone());
        match assets.verify_installed(&row.package_hash) {
            Ok(Some(_)) => {
                if row.state == "unavailable" {
                    library.mark_available(&row.package_hash).await?;
                }
            }
            _ => {
                library.mark_unavailable(&row.package_hash).await?;
            }
        }
    }
    for hash in assets.package_dirs() {
        if indexed_hashes.contains(&hash) {
            continue;
        }
        // 孤立目录：核验 original.hwpkg 的 hash 与投影后恢复入库。
        if matches!(assets.verify_installed(&hash), Ok(Some(_))) {
            let package = assets.read_installed_manifest(&hash)?;
            let result = library
                .install(&crate::wallpaper::library::InstallWork {
                    remote_work_id: package.manifest.work_id.clone(),
                    work_key: format!("local-{}", package.manifest.work_id),
                    title: package.manifest.title.clone(),
                    description: package.manifest.description.clone(),
                    kind: manifest_kind(&package.manifest),
                    package_hash: hash.clone(),
                    manifest_json: package.manifest_json.clone(),
                    package_bytes: assets.installed_bytes(&hash)?,
                    version: package.manifest.version,
                    source_id: LOCAL_SOURCE.into(),
                })
                .await;
            if let Err(error) = result {
                if error.code != "version_hash_conflict" {
                    return Err(error);
                }
                // 冲突孤包不覆盖已安装版本，也不能阻止其它作品恢复。
                crate::app::log(&format!("wallpaper recovery skipped {hash}: {error}"));
            }
        }
        // 核验失败的目录保留在盘上（孤立包清理策略属 P1-05 库 UI）。
    }
    // 可重建缓存的故障不能阻断原包库恢复；下一次导入会显式重试并报告错误。
    let cache_result = match super::derived_cache::Writer::acquire(assets) {
        Ok(cache) => cache
            .reclaim(library, 0, super::derived_cache::CAP)
            .await
            .map(|_| ()),
        Err(error) => Err(error),
    };
    if let Err(error) = cache_result {
        crate::app::log(&format!("wallpaper derived recovery deferred: {error}"));
    }
    Ok(())
}

fn manifest_kind(manifest: &hertz_wallpaper::manifest::Manifest) -> String {
    match &manifest.content {
        hertz_wallpaper::manifest::Content::Image { .. } => "image",
        hertz_wallpaper::manifest::Content::Video { .. } => "video",
        hertz_wallpaper::manifest::Content::Builtin { .. } => "builtin",
        hertz_wallpaper::manifest::Content::Composition { .. } => "composition",
        hertz_wallpaper::manifest::Content::Web { .. } => "web",
    }
    .to_string()
}

/// 测试与内核共用的 job id 生成（随机 256 位不透明句柄的前段）。
pub(crate) fn new_job_id() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    format!("{nanos:016x}{:04x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
