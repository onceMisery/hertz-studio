// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 导入任务管理（设计 docs/desktop-wallpaper.md §7.1/§12.1）。
//!
//! 资源准备任务全局一个：同一时刻最多一个活动导入，槽被占时立即返回
//! `budget_busy`（有界等待由调用方决定），不排队大任务。取消只作废代际；
//! 真实 I/O 退出并归还槽之后，任务才算终结（§7.1：「取消后先作废 job
//! generation，待真实 I/O/解码退出才归还槽，不能提前接受第二个大任务」）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::wallpaper::assets::AssetStore;
use crate::wallpaper::decode_probe::ProbeClient;
use crate::wallpaper::font_prepare::{FontInput, PreparedFont, RequiredText};
use crate::wallpaper::library::{Library, LOCAL_SOURCE};
use crate::wallpaper::target_planner::AssetRef;

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
    pub details: Option<Box<serde_json::Value>>,
}

impl JobError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(Box::new(details));
        self
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Preparing,
    Publishing,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    source: JobSource,
    status: Arc<Mutex<JobStatus>>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    target: Option<super::image_prepare::ImageTarget>,
    font_reply: Option<FontPrepareReply>,
    #[cfg(test)]
    terminal_pending: Option<std::sync::mpsc::Sender<JobState>>,
    #[cfg(test)]
    inspection_checkpoint: Option<fn(&AtomicBool)>,
}

enum JobSource {
    Import(ImportSource),
    Prepare(super::target_planner::PrepareRequest),
    PrepareFont(FontPrepareRequest),
    PrepareFontGroup(FontGroupPrepareRequest),
    PrepareSvg(SvgPrepareRequest),
}

/// 固定字体条目和最终文字由原准备 worker 核验；解析事实本身不授予本机资格。
#[derive(Clone)]
pub(crate) struct FontPrepareRequest {
    pub(crate) reference: AssetRef,
    pub(crate) expected_entry: hertz_wallpaper::VerifiedEntry,
    pub(crate) required_texts: Vec<RequiredText>,
}

#[derive(Clone)]
pub(crate) struct FontGroupPrepareRequest {
    pub(crate) fonts: Vec<FontPrepareRequest>,
    pub(crate) composition: super::composition_plan::FontTextPreflightContext,
}

impl FontGroupPrepareRequest {
    fn validate(&self) -> Result<(), JobError> {
        let limit = hertz_wallpaper::document::MAX_NODES;
        if self.fonts.is_empty() || self.fonts.len() > limit {
            return Err(JobError::invalid_input(
                "字体组必须为 1 至 128 个最终字体请求",
            ));
        }
        super::image_prepare::validate_target(Some(self.composition.target))?;
        let required = super::text_raster::required_texts_by_font(
            &self.composition.compiled,
            &self.composition.final_values,
        )?;
        if required.len() != self.fonts.len() {
            return Err(JobError::invalid_input("字体组必须覆盖全部最终字体"));
        }
        let mut ids = BTreeSet::new();
        for font in &self.fonts {
            font.reference.validate()?;
            if font.reference.variant_id.is_some()
                || font.reference.package_hash != self.composition.package_hash()
                || !ids.insert(font.reference.asset_id.as_str())
                || font.required_texts.len() > limit
                || font.required_texts.iter().any(|text| {
                    text.text.len() > 4 * 4096 || text.text.encode_utf16().count() > 4096
                })
            {
                return Err(JobError::invalid_input("字体组引用、数量或文字边界不一致"));
            }
            let expected = required
                .get(&font.reference.asset_id)
                .ok_or_else(|| JobError::invalid_input("字体组含有非最终字体请求"))?;
            fn pairs(texts: &[RequiredText]) -> BTreeSet<(&str, &str)> {
                texts
                    .iter()
                    .map(|text| (text.node_id.as_str(), text.text.as_str()))
                    .collect()
            }
            if expected.len() != font.required_texts.len()
                || pairs(expected) != pairs(&font.required_texts)
            {
                return Err(JobError::invalid_input(
                    "字体组文字必须为确切最终节点与原文字集合",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct SvgPrepareRequest {
    pub reference: AssetRef,
    pub target: super::image_prepare::ImageTarget,
    pub usage: String,
}
enum FontPrepareReply {
    Svg(tokio::sync::oneshot::Sender<Result<super::target_planner::ResolvedMedia, JobError>>),
    Single(tokio::sync::oneshot::Sender<Result<PreparedFont, JobError>>),
    Group(tokio::sync::oneshot::Sender<Result<BTreeMap<String, PreparedFont>, JobError>>),
}

type FontPrepareCompletion<T> = (String, tokio::sync::oneshot::Receiver<Result<T, JobError>>);

impl FontPrepareReply {
    fn send(self, outcome: Result<JobOutput, JobError>) {
        match (self, outcome) {
            (Self::Svg(reply), Ok(JobOutput::Svg(media))) => {
                let _ = reply.send(Ok(*media));
            }
            (Self::Svg(reply), Err(error)) => {
                let _ = reply.send(Err(error));
            }
            (Self::Single(reply), Ok(JobOutput::Font(font))) => {
                let _ = reply.send(Ok(*font));
            }
            (Self::Group(reply), Ok(JobOutput::Fonts(fonts))) => {
                let _ = reply.send(Ok(fonts));
            }
            (Self::Single(reply), Err(error)) => {
                let _ = reply.send(Err(error));
            }
            (Self::Group(reply), Err(error)) => {
                let _ = reply.send(Err(error));
            }
            _ => unreachable!("typed font reply belongs to its font source"),
        }
    }
}

enum JobOutput {
    Svg(Box<super::target_planner::ResolvedMedia>),
    Package(String),
    Font(Box<PreparedFont>),
    Fonts(BTreeMap<String, PreparedFont>),
}

enum ImportSource {
    Path(PathBuf),
    Pinned(super::file_tokens::SelectedFile),
}

/// 持久请求身份只由管理入口构造，作品和页面不能指定文件路径。
pub(crate) struct ImportIdentity {
    pub request_id: String,
    pub payload_digest: String,
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
        if !source.is_file() {
            return Err(JobError::invalid_input(format!(
                "导入源不存在或不是文件：{}",
                source.display()
            )));
        }
        self.enqueue(
            job_id,
            JobSource::Import(ImportSource::Path(source)),
            target,
        )
    }

    /// 正式管理入口：先持久接受记录再向同一个 worker 投递；重试返回既有 job。
    pub(crate) async fn submit_authorized(
        &self,
        job_id: String,
        file: super::file_tokens::SelectedFile,
        identity: ImportIdentity,
    ) -> Result<String, JobError> {
        if let Some(existing) = self.library.import_operation(&identity.request_id).await? {
            if existing.payload_digest != identity.payload_digest {
                return Err(JobError::new(
                    "request_id_conflict",
                    "相同请求 id 对应另一份输入",
                ));
            }
            return Ok(existing.job_id);
        }
        let request = self.reserve(job_id, JobSource::Import(ImportSource::Pinned(file)), None)?;
        let status = request.status.lock().expect("status").clone();
        let accepted = self.library.accept_import(&status, &identity).await;
        match accepted {
            Ok(accepted) if accepted == request.job_id => {
                let job_id = request.job_id.clone();
                let result = self.dispatch(request);
                if result.is_err() {
                    if let Some(status) = self.status(&job_id) {
                        self.library
                            .record_job(
                                &job_id,
                                None,
                                job_state_db(&status.state),
                                None,
                                serde_json::to_string(&status).ok().as_deref(),
                                status.error.as_deref(),
                            )
                            .await?;
                    }
                }
                result
            }
            result => {
                self.inner.lock().expect("job inner").current = None;
                result
            }
        }
    }

    /// TargetPlanner 的缺图请求复用导入 worker；只从已安装固定包准备，不再读取源文件。
    pub(crate) fn prepare_asset(
        &self,
        job_id: String,
        request: super::target_planner::PrepareRequest,
    ) -> Result<String, JobError> {
        request.reference.validate()?;
        super::image_prepare::validate_target(Some(request.target))?;
        let target = request.target;
        self.enqueue(job_id, JobSource::Prepare(request), Some(target))
    }

    /// 字体与导入/图片准备共用单槽；类型化回执只在原 worker 完整退出后发送。
    pub(crate) fn prepare_svg(
        &self,
        job_id: String,
        prepare: SvgPrepareRequest,
    ) -> Result<FontPrepareCompletion<super::target_planner::ResolvedMedia>, JobError> {
        prepare.reference.validate()?;
        super::image_prepare::validate_target(Some(prepare.target))?;
        if prepare.reference.variant_id.is_some()
            || !matches!(prepare.usage.as_str(), "color" | "sprite")
        {
            return Err(JobError::invalid_input("SVG 准备引用或 usage 无效"));
        }
        let mut request = self.reserve(job_id, JobSource::PrepareSvg(prepare), None)?;
        let (reply, receive) = tokio::sync::oneshot::channel();
        request.font_reply = Some(FontPrepareReply::Svg(reply));
        self.dispatch(request).map(|id| (id, receive))
    }
    pub(crate) fn prepare_font(
        &self,
        job_id: String,
        request: FontPrepareRequest,
    ) -> Result<FontPrepareCompletion<PreparedFont>, JobError> {
        request.reference.validate()?;
        let mut request = self.reserve(job_id, JobSource::PrepareFont(request), None)?;
        let (reply, receive) = tokio::sync::oneshot::channel();
        request.font_reply = Some(FontPrepareReply::Single(reply));
        self.dispatch(request).map(|job_id| (job_id, receive))
    }

    /// One group occupies the original slot through inspection, preflight,
    /// qualification and the same strict terminal database/cancellation guard.
    pub(crate) fn prepare_font_group(
        &self,
        job_id: String,
        request: FontGroupPrepareRequest,
    ) -> Result<FontPrepareCompletion<BTreeMap<String, PreparedFont>>, JobError> {
        request.validate()?;
        let mut request = self.reserve(job_id, JobSource::PrepareFontGroup(request), None)?;
        let (reply, receive) = tokio::sync::oneshot::channel();
        request.font_reply = Some(FontPrepareReply::Group(reply));
        self.dispatch(request).map(|job_id| (job_id, receive))
    }

    fn enqueue(
        &self,
        job_id: String,
        source: JobSource,
        target: Option<super::image_prepare::ImageTarget>,
    ) -> Result<String, JobError> {
        let request = self.reserve(job_id, source, target)?;
        self.dispatch(request)
    }

    fn reserve(
        &self,
        job_id: String,
        source: JobSource,
        target: Option<super::image_prepare::ImageTarget>,
    ) -> Result<JobRequest, JobError> {
        if job_id.is_empty()
            || job_id.len() > 64
            || !job_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(JobError::invalid_input("jobId 必须是有界的单个目录名"));
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
        Ok(JobRequest {
            job_id,
            source,
            status,
            cancel,
            generation,
            target,
            font_reply: None,
            #[cfg(test)]
            terminal_pending: None,
            #[cfg(test)]
            inspection_checkpoint: None,
        })
    }

    fn dispatch(&self, request: JobRequest) -> Result<String, JobError> {
        let job_id = request.job_id.clone();
        // 槽已在 inner 标记占用；若 worker 已死导致投递失败，这里同步归还槽。
        if let Err(error) = self.submit_tx.try_send(request) {
            let request = error.into_inner();
            drop(request.source);
            let mut status = request.status.lock().expect("status").clone();
            status.state = JobState::Failed;
            status.error = Some("worker_unavailable: 导入工作线程不可用".into());
            let mut guard = self.inner.lock().expect("job inner");
            guard.remember(status);
            guard.current = None;
            return Err(JobError::new("worker_unavailable", "导入工作线程不可用"));
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

    pub(crate) fn active_status(&self) -> Option<JobStatus> {
        self.inner
            .lock()
            .expect("job inner")
            .current
            .as_ref()
            .map(|job| job.status.lock().expect("status").clone())
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
        let mut outcome = match assets.content_writer() {
            Ok(writer) => {
                let preparation =
                    probe.prepare(format!("prepare-{}-{}", request.job_id, request.generation));
                let outcome = match preparation.as_ref() {
                    Ok(_) => match &request.source {
                        JobSource::Import(source) => {
                            run_import(&request, source, &library, &assets, &probe, &writer)
                                .await
                                .map(JobOutput::Package)
                        }
                        JobSource::Prepare(prepare) => {
                            run_prepare(&request, prepare, &library, &assets, &probe)
                                .await
                                .map(JobOutput::Package)
                        }
                        JobSource::PrepareSvg(prepare) => {
                            run_prepare_svg(&request, prepare, &library, &assets, &probe)
                                .await
                                .map(|media| JobOutput::Svg(Box::new(media)))
                        }
                        JobSource::PrepareFont(prepare) => {
                            run_prepare_font(&request, prepare, &library, &assets, &probe)
                                .await
                                .map(|font| JobOutput::Font(Box::new(font)))
                        }
                        JobSource::PrepareFontGroup(prepare) => {
                            run_prepare_font_group(&request, prepare, &library, &assets, &probe)
                                .await
                                .map(JobOutput::Fonts)
                        }
                    },
                    Err(error) => Err(JobError {
                        code: error.code,
                        message: error.message.clone(),
                        details: error.details.clone(),
                    }),
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
        // 源能力与读取句柄也须在终态发布前退出。
        drop(request.source);
        loop {
            if request.font_reply.is_some() && outcome.is_ok() {
                if let Err(error) = cancelled(&request.cancel) {
                    outcome = Err(error);
                }
            }
            let mut status = request.status.lock().expect("status").clone();
            match &outcome {
                Ok(output) => {
                    status.state = JobState::Done;
                    status.package_hash = Some(match output {
                        JobOutput::Package(hash) => hash.clone(),
                        JobOutput::Svg(media) => media.reference().package_hash.clone(),
                        JobOutput::Font(font) => font.reference().package_hash.clone(),
                        JobOutput::Fonts(fonts) => fonts
                            .values()
                            .next()
                            .expect("nonempty font group")
                            .reference()
                            .package_hash
                            .clone(),
                    });
                }
                Err(error) if error.code == "cancelled" => {
                    status.state = JobState::Cancelled;
                    status.error = Some(error.message.clone());
                }
                Err(error) => {
                    status.state = JobState::Failed;
                    status.error = Some(format!("{}: {}", error.code, error.message));
                }
            }
            let progress = serde_json::to_string(&status).ok();
            let terminal = library.record_job(
                &status.job_id,
                None,
                job_state_db(&status.state),
                None,
                progress.as_deref(),
                status.error.as_deref(),
            );
            #[cfg(test)]
            let terminal = {
                let mut terminal = std::pin::pin!(terminal);
                let mut notified = false;
                std::future::poll_fn(|context| {
                    let result = std::future::Future::poll(terminal.as_mut(), context);
                    if result.is_pending() && !notified {
                        if let Some(observer) = &request.terminal_pending {
                            let _ = observer.send(status.state);
                        }
                        notified = true;
                    }
                    result
                })
                .await
            };
            #[cfg(not(test))]
            let terminal = terminal.await;
            if let Err(error) = terminal {
                if request.font_reply.is_some() && outcome.is_ok() {
                    // 原终态记录失败不能发字体成功证明；旧导入仍保留既有 best-effort 行为。
                    status.state = JobState::Failed;
                    status.package_hash = None;
                    status.error = Some(format!("{}: {}", error.code, error.message));
                    outcome = Err(error);
                }
            }
            let mut guard = inner.lock().expect("job inner");
            // cancel 与归还原槽共用锁：DB 回执期间收到的取消也不能发成功字体证明。
            if request.font_reply.is_some()
                && outcome.is_ok()
                && request.cancel.load(Ordering::Acquire)
            {
                outcome = Err(JobError::new("cancelled", "字体准备已取消并退出"));
                continue;
            }
            guard.remember(status);
            guard.current = None;
            break;
        }
        if let Some(reply) = request.font_reply {
            reply.send(outcome);
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
    source: &ImportSource,
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
    let receipt = match source {
        ImportSource::Path(path) => {
            assets.snapshot_input(&request.job_id, path, Some(&request.cancel))
        }
        ImportSource::Pinned(file) => {
            assets.snapshot_open_file(&request.job_id, &file.file, Some(&request.cancel))
        }
    }?;
    let name = match source {
        ImportSource::Path(path) => path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("本地壁纸"),
        ImportSource::Pinned(file) => &file.name,
    };
    // Raw SVG probing has a small fixed maximum workspace before XML is read.
    let wrapping_workspace = probe.image_workspace(32 * 1024 * 1024)?;
    let wrapped =
        super::raw_import::ensure_package(assets, library, receipt, name, &request.cancel).await;
    wrapping_workspace.finish();
    let receipt = wrapped?;
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
        qualify_vectors(request, library, assets, probe, &package, None).await?;
        prepared.publish(assets, library).await?;
        cancelled(&request.cancel)?;
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
    qualify_vectors(
        request,
        library,
        assets,
        probe,
        &package,
        Some(&request.job_id),
    )
    .await?;
    cancelled(&request.cancel)?;
    // ⑥ Install：flush → 原子改名到 packageHash 目录（拒绝覆盖）。
    set_state(&request.status, JobState::Publishing);
    prepared.publish(assets, library).await?;
    cancelled(&request.cancel)?;
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

async fn run_prepare(
    request: &JobRequest,
    prepare: &super::target_planner::PrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<String, JobError> {
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    if !library
        .is_installed(&prepare.reference.package_hash)
        .await?
    {
        return Err(JobError::new("asset_not_found", "准备目标尚未安装或不可用"));
    }
    let package = assets.read_installed_manifest(&prepare.reference.package_hash)?;
    let inputs = assets.probe_installed_media(&package, &request.cancel)?;
    let (_, input) = super::target_planner::select_input(
        &package,
        &inputs,
        &prepare.reference,
        prepare.target,
        &["image/png".into(), "video/mp4".into(), "video/webm".into()],
    )?;
    if input.metadata.container != super::media::Container::Image {
        let poster = super::video_poster::prepare(
            assets,
            library,
            probe,
            &request.job_id,
            input,
            Arc::clone(&request.cancel),
        )
        .await?;
        cancelled(&request.cancel)?;
        if let Some(mut poster) = poster {
            poster.publish_optional(assets, library).await;
        }
        cancelled(&request.cancel)?;
        return Ok(package.package_hash);
    }
    let mut image = super::image_prepare::prepare(
        assets,
        library,
        probe,
        &request.job_id,
        &input,
        Some(prepare.target),
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
    cancelled(&request.cancel)?;
    set_state(&request.status, JobState::Publishing);
    image.publish(assets, library).await?;
    Ok(package.package_hash)
}

async fn run_prepare_svg(
    request: &JobRequest,
    prepare: &SvgPrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<super::target_planner::ResolvedMedia, JobError> {
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    if !library
        .is_installed(&prepare.reference.package_hash)
        .await?
    {
        return Err(JobError::new("asset_not_found", "SVG 原包尚未安装"));
    }
    let package = assets.read_installed_manifest(&prepare.reference.package_hash)?;
    let input = super::svg_prepare::pin_input(
        assets,
        &package,
        &prepare.reference.asset_id,
        None,
        &request.cancel,
    )?;
    let mut svg = super::svg_prepare::prepare(
        assets,
        library,
        probe,
        &request.job_id,
        &input,
        prepare.target,
        &prepare.usage,
        &request.cancel,
    )
    .await?;
    probe
        .qualify(
            library,
            svg.decode_input(assets, &input)?,
            Arc::clone(&request.cancel),
        )
        .await?;
    cancelled(&request.cancel)?;
    set_state(&request.status, JobState::Publishing);
    svg.publish(assets, library).await?;
    cancelled(&request.cancel)?;
    super::target_planner::ResolvedMedia::from_svg(
        prepare.reference.clone(),
        svg.decode_input(assets, &input)?,
        svg.content_key(),
        prepare.target,
        &svg.receipt,
    )
}
async fn qualify_vectors(
    request: &JobRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    package: &super::assets::StagedPackage,
    staging: Option<&str>,
) -> Result<(), JobError> {
    let target = request.target.unwrap_or(super::image_prepare::ImageTarget {
        width: 960,
        height: 540,
        fit: super::image_prepare::ImageFit::Contain,
        purpose: super::image_prepare::ImagePurpose::Preview,
    });
    for asset in package
        .manifest
        .assets
        .iter()
        .filter(|a| a.kind == hertz_wallpaper::AssetKind::Vector)
    {
        let input =
            super::svg_prepare::pin_input(assets, package, &asset.id, staging, &request.cancel)?;
        let mut svg = super::svg_prepare::prepare(
            assets,
            library,
            probe,
            &request.job_id,
            &input,
            target,
            "color",
            &request.cancel,
        )
        .await?;
        probe
            .qualify(
                library,
                svg.decode_input(assets, &input)?,
                Arc::clone(&request.cancel),
            )
            .await?;
        cancelled(&request.cancel)?;
        svg.publish(assets, library).await?;
        cancelled(&request.cancel)?;
    }
    Ok(())
}

async fn run_prepare_font(
    request: &JobRequest,
    prepare: &FontPrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<PreparedFont, JobError> {
    set_state(&request.status, JobState::Preparing);
    let input = inspect_font(request, prepare, library, assets, probe).await?;
    qualify_inspected_font(request, prepare, input, library, probe).await
}

async fn inspect_font(
    request: &JobRequest,
    prepare: &FontPrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<FontInput, JobError> {
    cancelled(&request.cancel)?;
    if !library
        .is_installed(&prepare.reference.package_hash)
        .await?
    {
        return Err(JobError::new("asset_not_found", "准备字体尚未安装或不可用"));
    }
    // 原准备槽/写门已持有；字体读取、目录核验和解析先取得完整 CPU 工作区。
    let workspace = probe.image_workspace(super::font_prepare::prepare_workspace_bytes(
        prepare.expected_entry.bytes,
    )?)?;
    #[cfg(test)]
    if let Some(checkpoint) = request.inspection_checkpoint {
        checkpoint(&request.cancel);
    }
    let input = super::font_prepare::pin_input(
        assets,
        &prepare.reference,
        &prepare.expected_entry,
        &prepare.required_texts,
        &workspace,
        &request.cancel,
    );
    // pin_input 同步读取与解析已实际退出，所有成功/错误路径均确认归还工作区。
    workspace.finish();
    input
}

async fn qualify_inspected_font(
    request: &JobRequest,
    prepare: &FontPrepareRequest,
    input: FontInput,
    library: &Library,
    probe: &ProbeClient,
) -> Result<PreparedFont, JobError> {
    cancelled(&request.cancel)?;
    let proof = probe
        .qualify_font(library, input.clone(), Arc::clone(&request.cancel))
        .await?;
    cancelled(&request.cancel)?;
    let font = PreparedFont::after_qualification(prepare.reference.clone(), input, proof)?;
    cancelled(&request.cancel)?;
    Ok(font)
}

async fn run_prepare_font_group(
    request: &JobRequest,
    prepare: &FontGroupPrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<BTreeMap<String, PreparedFont>, JobError> {
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    prepare.validate()?;
    let ordered: BTreeMap<_, _> = prepare
        .fonts
        .iter()
        .map(|font| (font.reference.asset_id.clone(), font))
        .collect();
    let mut inputs = BTreeMap::new();
    for (id, font) in &ordered {
        // Each temporary read/parser workspace physically finishes before the
        // next input; only sealed pins, metadata and exact proofs survive.
        let input = inspect_font(request, font, library, assets, probe).await?;
        inputs.insert(id.clone(), input);
    }
    cancelled(&request.cancel)?;
    let lower_bound = prepare.composition.memory_request(
        &inputs,
        format!("font-preflight-{}", request.job_id),
        request.generation,
    )?;
    cancelled(&request.cancel)?;
    probe.check_requests(&[lower_bound])?;
    cancelled(&request.cancel)?;
    let mut fonts = BTreeMap::new();
    for (id, font) in ordered {
        let input = inputs
            .remove(&id)
            .expect("every font inspected before preflight");
        let font = qualify_inspected_font(request, font, input, library, probe).await?;
        fonts.insert(id, font);
    }
    cancelled(&request.cancel)?;
    Ok(fonts)
}

#[derive(Default)]
struct PreparedMedia {
    images: Vec<super::image_prepare::PreparedImage>,
    posters: Vec<super::video_poster::PreparedPoster>,
}
impl PreparedMedia {
    async fn publish(&mut self, assets: &AssetStore, library: &Library) -> Result<(), JobError> {
        for image in &mut self.images {
            image.publish(assets, library).await?;
        }
        for poster in &mut self.posters {
            poster.publish_optional(assets, library).await;
        }
        Ok(())
    }
}

async fn qualify_media(
    request: &JobRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    inputs: Vec<super::assets::DecodeInput>,
) -> Result<PreparedMedia, JobError> {
    let mut prepared = PreparedMedia::default();
    for input in inputs {
        cancelled(&request.cancel)?;
        if input.metadata.container == super::media::Container::Image {
            if let Some(image) = prepared
                .images
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
                prepared.images.push(image);
            }
        } else if let Some(poster) = super::video_poster::prepare(
            assets,
            library,
            probe,
            &request.job_id,
            input,
            Arc::clone(&request.cancel),
        )
        .await?
        {
            prepared.posters.push(poster);
        }
    }
    Ok(prepared)
}

/// 启动恢复（§7.2）：目录在索引缺 → 核验后恢复入库；索引在目录缺 → unavailable。
/// 崩溃恢复不自动启用任何作品（启用意图在 config 域）。
pub async fn reconcile_startup(library: &Library, assets: &AssetStore) -> Result<(), JobError> {
    let _writer = assets.content_writer()?;
    library.interrupt_imports().await?;
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
