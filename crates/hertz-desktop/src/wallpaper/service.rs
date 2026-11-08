// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 正式库管理调度。现有 ImportJobs/AssetStore/Library 继续分别持有任务、字节和索引。
//! GUI 只投递有界控制消息；文件、SQL、对话框和恢复均在后台执行。

use super::api::{self, Command, Request};
use super::assets::AssetStore;
use super::decode_probe::ProbeClient;
use super::file_tokens::{self, FileTokens};
use super::jobs::{self, ImportIdentity, ImportJobs, JobError};
use super::library::Library;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REQUEST_CAP: usize = 4;
const HISTORY_CAP: usize = 256;
const HISTORY_TTL: Duration = Duration::from_secs(600);
const LAYOUT_CACHE_CAP: usize = 16;
const LAYOUT_CACHE_TTL: Duration = Duration::from_secs(30);

type Initialization = Option<Result<(), Arc<JobError>>>;
type Reply = Box<dyn FnOnce(Value) + Send>;
enum Work {
    Command(Call),
    AiCatalog {
        brief: String,
        context: super::ai::CatalogContext,
        reply: Box<dyn FnOnce(Result<super::ai::Catalog, JobError>) + Send>,
        slot: Slot,
    },
    Resolve(ResolveCall),
    DraftDocument {
        id: String,
        revision: u64,
        owner: u64,
        reply: Box<dyn FnOnce(Result<super::work_drafts::Document, JobError>) + Send>,
        slot: Slot,
    },
    PlaylistSelection {
        selection: super::config::Selection,
        target: super::image_prepare::ImageTarget,
        options: super::selection_plan::SelectionOptions,
        cancel: Arc<AtomicBool>,
        reply: Box<
            dyn FnOnce(Result<super::selection_plan::ResolvedPlan, super::selection_plan::Failure>)
                + Send,
        >,
        slot: Slot,
    },
    ValidateMirrorLayouts {
        selections: Vec<(super::config::Selection, usize)>,
        properties: Vec<super::public_properties::PropertySelection>,
        cancel: Arc<AtomicBool>,
        reply: Box<dyn FnOnce(Result<(), JobError>) + Send>,
        slot: Slot,
        ai: Option<super::ai::Authority>,
    },
}
struct ResolveCall {
    request: super::selection_plan::Request,
    cancel: Arc<AtomicBool>,
    reply: Box<
        dyn FnOnce(Result<super::selection_plan::ResolvedSelection, super::selection_plan::Failure>)
            + Send,
    >,
    _slot: Slot,
}
struct Call {
    request: Request,
    owner: u64,
    hwnd: isize,
    playlist_properties: Vec<serde_json::Map<String, Value>>,
    references: super::references::Report,
    reply: Reply,
    _slot: Slot,
}
pub(crate) struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
#[derive(Clone)]
struct Record {
    digest: String,
    command: String,
    started: Instant,
    response: Option<Value>,
}

struct State {
    base: PathBuf,
    probe: ProbeClient,
    jobs: tokio::sync::OnceCell<Arc<ImportJobs>>,
    exports: tokio::sync::OnceCell<super::export_jobs::ExportJobs>,
    initialization: tokio::sync::OnceCell<tokio::sync::watch::Receiver<Initialization>>,
    tokens: Arc<FileTokens>,
    output_tokens: Arc<super::output_tokens::OutputTokens>,
    dialog_open: Arc<AtomicBool>,
    history: Mutex<HashMap<String, Record>>,
    poster_reader: Arc<tokio::sync::Semaphore>,
    layout_reader: Arc<tokio::sync::Semaphore>,
    layout_inspections: Arc<LayoutInspectionCoordinator>,
}

#[derive(Clone)]
struct LayoutError {
    code: &'static str,
    message: String,
}

struct LayoutOutcome {
    result: Mutex<
        Option<(
            Instant,
            std::result::Result<super::selection_plan::LayoutInspection, LayoutError>,
        )>,
    >,
}

impl LayoutOutcome {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
        }
    }

    fn finish(
        &self,
        result: std::result::Result<super::selection_plan::LayoutInspection, JobError>,
    ) {
        let result = result.map_err(|error| LayoutError {
            code: error.code,
            message: error.message,
        });
        *self
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some((Instant::now(), result));
    }

    fn take(
        &self,
    ) -> Option<(
        Instant,
        std::result::Result<super::selection_plan::LayoutInspection, LayoutError>,
    )> {
        self.result
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

struct LayoutActive {
    key: String,
    outcome: Arc<LayoutOutcome>,
    cancel: Arc<AtomicBool>,
    generation: u64,
}

struct LayoutCached {
    key: String,
    finished: Instant,
    value: super::selection_plan::LayoutInspection,
}

struct LayoutInspectionCoordinator {
    state: Mutex<LayoutInspectionState>,
    #[cfg(test)]
    worker_gate: Mutex<Option<LayoutWorkerTestGate>>,
}

#[cfg(test)]
struct LayoutWorkerTestGate {
    entered: std::sync::mpsc::SyncSender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

struct LayoutInspectionState {
    active: Option<LayoutActive>,
    cache: VecDeque<LayoutCached>,
    generation: u64,
    active_import: Option<String>,
    stopped: bool,
}

enum LayoutLookup {
    Ready(std::result::Result<super::selection_plan::LayoutInspection, JobError>),
    Pending,
    Busy,
    Start {
        outcome: Arc<LayoutOutcome>,
        cancel: Arc<AtomicBool>,
    },
}

impl LayoutInspectionCoordinator {
    fn new() -> Self {
        Self {
            state: Mutex::new(LayoutInspectionState {
                active: None,
                cache: VecDeque::new(),
                generation: 0,
                active_import: None,
                stopped: false,
            }),
            #[cfg(test)]
            worker_gate: Mutex::new(None),
        }
    }

    fn lookup(&self, key: &str, generation: u64, now: Instant) -> LayoutLookup {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.stopped {
            return LayoutLookup::Ready(Err(JobError::new("cancelled", "布局检查服务正在退出")));
        }
        if generation != state.generation {
            return LayoutLookup::Busy;
        }
        state
            .cache
            .retain(|entry| now.saturating_duration_since(entry.finished) <= LAYOUT_CACHE_TTL);
        if let Some(active) = state.active.as_ref() {
            if let Some((finished, result)) = active.outcome.take() {
                let active = state.active.take().expect("active layout task");
                if active.generation == state.generation
                    && now.saturating_duration_since(finished) <= LAYOUT_CACHE_TTL
                {
                    match result {
                        Ok(value) => {
                            state.cache.push_back(LayoutCached {
                                key: active.key,
                                finished,
                                value,
                            });
                            while state.cache.len() > LAYOUT_CACHE_CAP {
                                state.cache.pop_front();
                            }
                        }
                        Err(error) if active.key == key => {
                            return LayoutLookup::Ready(Err(JobError::new(
                                error.code,
                                error.message,
                            )));
                        }
                        Err(_) => {}
                    }
                }
            }
        }
        if let Some(entry) = state.cache.iter().find(|entry| entry.key == key) {
            return LayoutLookup::Ready(Ok(entry.value.clone()));
        }
        if let Some(active) = state.active.as_ref() {
            return if active.key == key && active.generation == state.generation {
                LayoutLookup::Pending
            } else {
                LayoutLookup::Busy
            };
        }
        let outcome = Arc::new(LayoutOutcome::new());
        let cancel = Arc::new(AtomicBool::new(false));
        state.active = Some(LayoutActive {
            key: key.to_owned(),
            outcome: Arc::clone(&outcome),
            cancel: Arc::clone(&cancel),
            generation: state.generation,
        });
        LayoutLookup::Start { outcome, cancel }
    }

    fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.cache.clear();
        if let Some(active) = state.active.as_ref() {
            active.cancel.store(true, Ordering::Release);
        }
    }

    fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .generation
    }

    fn begin_import(&self, job_id: String) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.active_import.as_ref() != Some(&job_id) {
            state.active_import = Some(job_id);
            state.generation = state.generation.wrapping_add(1);
            state.cache.clear();
            if let Some(active) = state.active.as_ref() {
                active.cancel.store(true, Ordering::Release);
            }
        }
    }

    fn observe_import(&self, active_job: Option<&str>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .active_import
            .as_deref()
            .is_some_and(|job_id| active_job != Some(job_id))
        {
            state.active_import = None;
            state.generation = state.generation.wrapping_add(1);
            state.cache.clear();
            if let Some(active) = state.active.as_ref() {
                active.cancel.store(true, Ordering::Release);
            }
        }
    }

    fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.stopped = true;
        state.generation = state.generation.wrapping_add(1);
        state.cache.clear();
        if let Some(active) = state.active.as_ref() {
            active.cancel.store(true, Ordering::Release);
        }
    }
}

struct LayoutInvalidation(Arc<LayoutInspectionCoordinator>);
impl Drop for LayoutInvalidation {
    fn drop(&mut self) {
        self.0.invalidate();
    }
}

pub(crate) struct LibraryService {
    tx: tokio::sync::mpsc::Sender<Work>,
    pending: Arc<AtomicUsize>,
    state: Arc<State>,
}

impl LibraryService {
    pub(crate) fn start(base: PathBuf, probe: ProbeClient) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Work>(REQUEST_CAP);
        let pending = Arc::new(AtomicUsize::new(0));
        let state = Arc::new(State {
            base,
            probe,
            jobs: tokio::sync::OnceCell::new(),
            exports: tokio::sync::OnceCell::new(),
            initialization: tokio::sync::OnceCell::new(),
            tokens: Arc::new(FileTokens::default()),
            output_tokens: Arc::new(super::output_tokens::OutputTokens::default()),
            dialog_open: Arc::new(AtomicBool::new(false)),
            history: Mutex::new(HashMap::new()),
            poster_reader: Arc::new(tokio::sync::Semaphore::new(1)),
            layout_reader: Arc::new(tokio::sync::Semaphore::new(1)),
            layout_inspections: Arc::new(LayoutInspectionCoordinator::new()),
        });
        let worker = Arc::clone(&state);
        std::thread::Builder::new().name("hertz-wallpaper-management".into()).spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("wallpaper management runtime");
            tokio::task::LocalSet::new().block_on(&runtime, async move {
                let mut tasks = tokio::task::JoinSet::new();
                loop {
                    worker.tokens.prune(Instant::now());
                    worker.output_tokens.prune(Instant::now());
                    let wake = worker.tokens.next_expiry().into_iter().chain(worker.output_tokens.next_expiry()).min().unwrap_or_else(|| Instant::now()+Duration::from_secs(3600));
                    tokio::select! {
                        call = rx.recv() => {
                            let Some(call) = call else { break; };
                            let state = Arc::clone(&worker);
                            tasks.spawn_local(async move {
                                match call {
                                    Work::Command(call) => { let _slot = call._slot; let value = state.handle(&call.request, call.owner, call.hwnd, &call.playlist_properties, &call.references).await; (call.reply)(value); }
                                    Work::AiCatalog {brief, context, reply, slot} => {
                                        let _slot = slot;
                                        let result = match state.jobs().await { Ok(jobs) => super::ai::catalog(Arc::clone(jobs), brief, context).await, Err(error) => Err(error) };
                                        reply(result);
                                    }
                                    Work::DraftDocument { id, revision, owner, reply, slot } => {
                                        let _slot = slot;
                                        let result = async {
                                            let jobs = state.jobs().await?;
                                            let draft = super::work_drafts::WorkDrafts::new(jobs.library()).get(&id).await?;
                                            state.check_owner(owner)?;
                                            if draft.revision != revision { return Err(JobError::new("draft_conflict", "作品草稿已变化，请重新预览")); }
                                            Ok(draft.document)
                                        }.await;
                                        reply(result);
                                    }
                                    Work::PlaylistSelection { selection, target, options, cancel, reply, slot } => {
                                        let _slot = slot;
                                        let result = match state.jobs().await {
                                            Ok(jobs) => super::selection_plan::resolve_selection_with_options(Arc::clone(jobs), selection, target, options, cancel).await,
                                            Err(error) => Err(error.into()),
                                        };
                                        reply(result);
                                    }
                                    Work::ValidateMirrorLayouts { selections, properties, cancel, reply, slot, ai } => {
                                        let _slot = slot;
                                        let result = match state.jobs().await {
                                            Ok(jobs) => {
                                                let jobs = Arc::clone(jobs);
                                                let runtime = tokio::runtime::Handle::current();
                                                tokio::task::spawn_blocking(move || {
                                                    runtime.block_on(async {
                                                        if let Some(authority) = ai.as_ref() { super::ai::revalidate(&jobs, authority).await?; }
                                                        if !selections.is_empty() {
                                                            super::selection_plan::validate_mirror_layouts(&jobs, selections, &cancel).await?;
                                                        }
                                                        super::public_properties::validate_selections(&jobs, &properties, &cancel).await
                                                    })
                                                }).await.unwrap_or_else(|_| Err(JobError::new("worker_unavailable", "镜像布局核验线程已退出")))
                                            }
                                            Err(error) => Err(error),
                                        };
                                        reply(result);
                                    }
                                    Work::Resolve(call) => {
                                        let _slot = call._slot;
                                        let result = if call.cancel.load(Ordering::Acquire) { Err(JobError::new("cancelled", "媒体选择已取消").into()) } else { match state.jobs().await {
                                            Ok(jobs) => super::selection_plan::resolve(Arc::clone(jobs), call.request, call.cancel).await,
                                            Err(error) => Err(error.into()),
                                        }};
                                        (call.reply)(result);
                                    }
                                }
                            });
                        }
                        _ = tasks.join_next(), if !tasks.is_empty() => {}
                        _ = tokio::time::sleep_until(wake.into()) => {}
                    }
                }
                while tasks.join_next().await.is_some() {}
            });
        }).expect("wallpaper management thread");
        Self { tx, pending, state }
    }

    pub(crate) fn set_settings_owner(&self, owner: u64) {
        self.state.tokens.set_owner(owner);
        self.state.output_tokens.set_owner(owner);
    }

    pub(crate) fn recommend_ai(&self, brief: String, context: super::ai::CatalogContext,
        reply: impl FnOnce(Result<super::ai::Catalog, JobError>) + Send + 'static) -> Result<(), JobError> {
        let slot = self.reserve()?;
        self.tx.try_send(Work::AiCatalog {brief, context, reply: Box::new(reply), slot})
            .map_err(|_| JobError::new("budget_busy", "原壁纸管理队列暂不可用"))
    }

    pub(crate) fn revalidate_ai(&self, authority: super::ai::Authority, cancel: Arc<AtomicBool>, slot: Slot,
        reply: impl FnOnce(Result<(), JobError>) + Send + 'static) -> Result<(), JobError> {
        self.tx.try_send(Work::ValidateMirrorLayouts { selections: vec![], properties: vec![], cancel, reply:Box::new(reply), slot, ai:Some(authority) })
            .map_err(|_| JobError::new("budget_busy", "原壁纸管理队列暂不可用"))
    }

    pub(crate) fn read_work_document(
        &self,
        id: String,
        revision: u64,
        owner: u64,
        slot: Slot,
        reply: impl FnOnce(Result<super::work_drafts::Document, JobError>) + Send + 'static,
    ) -> Result<(), JobError> {
        self.tx
            .try_send(Work::DraftDocument {
                id,
                revision,
                owner,
                reply: Box::new(reply),
                slot,
            })
            .map_err(|_| JobError::new("budget_busy", "作品管理正在退出或暂不可用"))
    }
    pub(crate) fn resolve_desktop_selection(
        &self,
        selection: super::config::Selection,
        target: super::image_prepare::ImageTarget,
        options: super::selection_plan::SelectionOptions,
        cancel: Arc<AtomicBool>,
        slot: Slot,
        reply: impl FnOnce(Result<super::selection_plan::ResolvedPlan, super::selection_plan::Failure>)
            + Send
            + 'static,
    ) -> Result<(), JobError> {
        self.tx
            .try_send(Work::PlaylistSelection {
                selection,
                target,
                options,
                cancel,
                slot,
                reply: Box::new(reply),
            })
            .map_err(|_| JobError::new("budget_busy", "作品管理正在退出或暂不可用"))
    }

    pub(crate) fn validate_mirror_layouts(
        &self,
        selections: Vec<(super::config::Selection, usize)>,
        cancel: Arc<AtomicBool>,
        slot: Slot,
        reply: impl FnOnce(Result<(), JobError>) + Send + 'static,
    ) -> Result<(), JobError> {
        self.validate_presentation_intents(selections, vec![], cancel, slot, reply)
    }

    pub(crate) fn validate_presentation_intents(
        &self,
        selections: Vec<(super::config::Selection, usize)>,
        properties: Vec<super::public_properties::PropertySelection>,
        cancel: Arc<AtomicBool>,
        slot: Slot,
        reply: impl FnOnce(Result<(), JobError>) + Send + 'static,
    ) -> Result<(), JobError> {
        if (selections.is_empty() && properties.is_empty())
            || selections.len() > 4
            || properties.len() > 4
            || selections
                .iter()
                .any(|(_, members)| !(1..=4).contains(members))
        {
            return Err(JobError::invalid_input("镜像布局核验需要 1–4 个有效显示组"));
        }
        self.tx
            .try_send(Work::ValidateMirrorLayouts {
                selections,
                properties,
                cancel,
                reply: Box::new(reply),
                slot,
                ai: None,
            })
            .map_err(|_| JobError::new("budget_busy", "作品管理正在退出或暂不可用"))
    }

    pub(crate) fn submit(
        &self,
        request: Request,
        owner: u64,
        hwnd: isize,
        reply: impl FnOnce(Value) + Send + 'static,
    ) -> Result<(), JobError> {
        self.submit_with_properties(request, owner, hwnd, vec![], reply)
    }

    pub(crate) fn submit_with_properties(
        &self,
        request: Request,
        owner: u64,
        hwnd: isize,
        playlist_properties: Vec<serde_json::Map<String, Value>>,
        reply: impl FnOnce(Value) + Send + 'static,
    ) -> Result<(), JobError> {
        self.submit_with_context(
            request,
            owner,
            hwnd,
            playlist_properties,
            super::references::Report::default(),
            reply,
        )
    }

    pub(crate) fn submit_with_context(
        &self,
        request: Request,
        owner: u64,
        hwnd: isize,
        playlist_properties: Vec<serde_json::Map<String, Value>>,
        references: super::references::Report,
        reply: impl FnOnce(Value) + Send + 'static,
    ) -> Result<(), JobError> {
        let slot = self.reserve()?;
        let call = Call {
            request,
            owner,
            hwnd,
            playlist_properties,
            references,
            reply: Box::new(reply),
            _slot: slot,
        };
        self.tx
            .try_send(Work::Command(call))
            .map_err(|_| JobError::new("budget_busy", "壁纸管理正在退出或暂不可用"))
    }
    /// A bounded native-only task, sharing admission and the canonical ImportJobs worker.
    pub(crate) fn resolve_selection(
        &self,
        request: super::selection_plan::Request,
        cancel: Arc<AtomicBool>,
        reply: impl FnOnce(Result<super::selection_plan::ResolvedSelection, super::selection_plan::Failure>)
            + Send
            + 'static,
    ) -> Result<(), JobError> {
        let slot = self.reserve()?;
        self.resolve_selection_reserved(request, cancel, slot, reply)
    }

    pub(crate) fn resolve_selection_reserved(
        &self,
        request: super::selection_plan::Request,
        cancel: Arc<AtomicBool>,
        slot: Slot,
        reply: impl FnOnce(Result<super::selection_plan::ResolvedSelection, super::selection_plan::Failure>)
            + Send
            + 'static,
    ) -> Result<(), JobError> {
        request.validate()?;
        self.tx
            .try_send(Work::Resolve(ResolveCall {
                request,
                cancel,
                reply: Box::new(reply),
                _slot: slot,
            }))
            .map_err(|_| JobError::new("budget_busy", "媒体选择管理正在退出或暂不可用"))
    }

    #[allow(deprecated)] // MSRV 1.88 还没有 try_update，理由见 vmusic-lan/src/buffer.rs
    pub(crate) fn reserve(&self) -> Result<Slot, JobError> {
        self.pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < REQUEST_CAP).then_some(count + 1)
            })
            .map_err(|_| JobError::new("budget_busy", "已有四个壁纸管理请求，请等待完成"))?;
        Ok(Slot(Arc::clone(&self.pending)))
    }
    pub(crate) fn begin_local(&self, request: &Request) -> Result<Option<Value>, JobError> {
        self.state.begin_request(request)
    }
    pub(crate) fn finish_local(&self, request: &Request, value: &Value) {
        self.state.finish_request(request, value);
    }
}

impl Drop for LibraryService {
    fn drop(&mut self) {
        self.set_settings_owner(0);
        self.state.layout_inspections.stop();
    }
}

impl State {
    async fn exports(self: &Arc<Self>) -> Result<&super::export_jobs::ExportJobs, JobError> {
        let jobs = Arc::clone(self.jobs().await?);
        self.exports
            .get_or_try_init(|| async { super::export_jobs::ExportJobs::start(jobs).await })
            .await
    }
    async fn jobs(self: &Arc<Self>) -> Result<&Arc<ImportJobs>, JobError> {
        if let Some(jobs) = self.jobs.get() {
            return Ok(jobs);
        }
        // 初始化独立于观察者期限：同步目录/哈希工作在 blocking 线程执行，
        // 查询超时不会取消或重复启动恢复，也不会堵住能力查询与令牌过期。
        let mut ready = self
            .initialization
            .get_or_init(|| async {
                let (send, receive) = tokio::sync::watch::channel(None);
                let state = Arc::clone(self);
                tokio::spawn(async move {
                    let base = state.base.clone();
                    let probe = state.probe.clone();
                    let runtime = tokio::runtime::Handle::current();
                    let initialized = tokio::task::spawn_blocking(move || {
                        runtime.block_on(async move {
                            let library = Library::open(&base).await?;
                            let assets = AssetStore::new(&base)?;
                            jobs::reconcile_startup(&library, &assets).await?;
                            Ok::<_, JobError>(Arc::new(ImportJobs::start(library, assets, probe)))
                        })
                    })
                    .await
                    .unwrap_or_else(|error| Err(JobError::io(error.to_string())));
                    let result = match initialized {
                        Ok(jobs) => {
                            // Recover output commit receipts before exposing the library.
                            // Do not call exports() here: that would recurse into jobs().
                            match super::export_jobs::ExportJobs::start(Arc::clone(&jobs)).await {
                                Ok(exports) => {
                                    let _ = state.exports.set(exports);
                                    let _ = state.jobs.set(jobs);
                                    Ok(())
                                }
                                Err(error) => Err(Arc::new(error)),
                            }
                        }
                        Err(error) => Err(Arc::new(error)),
                    };
                    let _ = send.send(Some(result));
                });
                receive
            })
            .await
            .clone();
        loop {
            if let Some(result) = ready.borrow().as_ref() {
                return match result {
                    Ok(()) => Ok(self.jobs.get().expect("initialized import jobs")),
                    Err(error) => Err(JobError::new(error.code, error.message.clone())),
                };
            }
            ready
                .changed()
                .await
                .map_err(|_| JobError::new("service_starting", "作品库初始化未完成"))?;
        }
    }

    /// 删除顺序：内容写门 → 只读计划 → 移除不再被引用的包目录 → 库行事务。
    /// app 在提交前已检查配置/草稿/预览引用；这里再核对 UI 给出的版本与包绑定。
    async fn delete_library(
        self: &Arc<Self>,
        work_key: String,
        version: Option<i64>,
        package_hash: Option<String>,
        runtime_references: &super::references::Report,
    ) -> Result<Value, JobError> {
        let jobs = self.jobs().await?;
        let _writer = jobs.assets().content_writer()?;
        let plan = jobs.library().plan_deletion(&work_key, version).await?;
        if let Some(package_hash) = package_hash.as_ref() {
            if plan.versions.len() != 1 || &plan.versions[0].package_hash != package_hash {
                return Err(JobError::new(
                    "version_not_found",
                    "版本与包 hash 不匹配，请刷新作品库后重试",
                ));
            }
        }
        let mut references = runtime_references.clone();
        references.extend(
            super::references::stored(jobs.library(), &work_key, package_hash.as_deref()).await?,
        );
        if !references.is_empty() {
            return Err(references.in_use_error());
        }
        for hash in &plan.package_hashes {
            jobs.assets().remove_installed(hash).await?;
        }
        jobs.library().delete_rows(&plan).await?;
        Ok(json!({
            "deleted": true,
            "workKey": plan.work_key,
            "workDeleted": plan.delete_work,
            "versions": plan.versions.len(),
            "packages": plan.package_hashes.len(),
        }))
    }

    fn begin_request(&self, request: &Request) -> Result<Option<Value>, JobError> {
        let digest = request.digest();
        let mut history = self
            .history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        history.retain(|_, record| {
            record.response.is_none() || record.started.elapsed() < HISTORY_TTL
        });
        if let Some(record) = history.get(&request.request_id) {
            if record.digest != digest {
                return Err(JobError::new(
                    "request_id_conflict",
                    "相同请求 id 对应另一份内容",
                ));
            }
            // An inspection poll is a fresh read, including when callers reuse requestId.
            // Cached pending/eligibility receipts must not freeze the changing task state.
            if request.command == "wallpaper.layout.inspect" && record.response.is_some() {
                return Ok(None);
            }
            return record.response.clone().map(Some).ok_or_else(|| {
                JobError::new("operation_pending", "请求仍在处理，请按 requestId 查询")
            });
        }
        if request.command == "wallpaper.layout.inspect" {
            // A long inspection can receive many fresh polling IDs. Keep only a small
            // completed read history instead of exhausting mutation idempotency records.
            let mut completed: Vec<_> = history
                .iter()
                .filter(|(_, record)| {
                    record.command == "wallpaper.layout.inspect" && record.response.is_some()
                })
                .map(|(id, record)| (id.clone(), record.started))
                .collect();
            completed.sort_by_key(|(_, started)| *started);
            let remove = completed.len().saturating_sub(LAYOUT_CACHE_CAP - 1);
            for (id, _) in completed.into_iter().take(remove) {
                history.remove(&id);
            }
        }
        if history.len() >= HISTORY_CAP {
            return Err(JobError::new("budget_busy", "管理请求记录已满，请稍后重试"));
        }
        history.insert(
            request.request_id.clone(),
            Record {
                digest,
                command: request.command.clone(),
                started: Instant::now(),
                response: None,
            },
        );
        Ok(None)
    }
    fn finish_request(&self, request: &Request, value: &Value) {
        if let Some(record) = self
            .history
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(&request.request_id)
        {
            record.response = Some(value.clone());
        }
    }

    async fn handle(
        self: &Arc<Self>,
        request: &Request,
        owner: u64,
        hwnd: isize,
        playlist_properties: &[serde_json::Map<String, Value>],
        references: &super::references::Report,
    ) -> Value {
        match self.begin_request(request) {
            Ok(Some(value)) => return value,
            Err(error) => return api::response(Some(&request.request_id), Err(error), None),
            Ok(None) => {}
        }
        let read_only = matches!(
            request.typed(),
            Ok(Command::Capabilities
                | Command::LayoutInspect { .. }
                | Command::PropertiesInspect { .. }
                | Command::Status
                | Command::LibraryList { .. }
                | Command::LibraryGet { .. }
                | Command::LibraryReferences { .. }
                | Command::LibraryPoster { .. }
                | Command::JobsGet { .. }
                | Command::OperationsGet { .. })
        );
        let result = if read_only {
            tokio::time::timeout(
                Duration::from_secs(2),
                self.execute(request, owner, hwnd, playlist_properties, references),
            )
            .await
            .unwrap_or_else(|_| {
                Err(JobError::new(
                    "query_timeout",
                    "查询超过期限，请按新的请求重新读取",
                ))
            })
        } else {
            self.execute(request, owner, hwnd, playlist_properties, references)
                .await
        };
        let job_id = result
            .as_ref()
            .ok()
            .and_then(|value| value["jobId"].as_str())
            .map(str::to_string);
        let mut value = api::response(Some(&request.request_id), result, job_id.as_deref());
        if hertz_desktop_ipc::frame::serialize_bounded(
            &value,
            hertz_desktop_ipc::management::RESPONSE_LIMIT,
        )
        .is_err()
        {
            value = api::response(
                Some(&request.request_id),
                Err(JobError::new(
                    "response_too_large",
                    "响应超过 64 KiB，请缩小分页",
                )),
                None,
            );
        }
        self.finish_request(request, &value);
        value
    }

    async fn execute(
        self: &Arc<Self>,
        request: &Request,
        owner: u64,
        hwnd: isize,
        playlist_properties: &[serde_json::Map<String, Value>],
        runtime_references: &super::references::Report,
    ) -> Result<Value, JobError> {
        let command = request.typed()?;
        let _layout_invalidation = if matches!(
            command,
            Command::PlaylistSave { .. }
                | Command::LibraryDeleteWork { .. }
                | Command::LibraryDeleteVersion { .. }
                | Command::ImportBegin { .. }
                | Command::WorkDraftPublish { .. }
        ) {
            self.layout_inspections.invalidate();
            Some(LayoutInvalidation(Arc::clone(&self.layout_inspections)))
        } else {
            None
        };
        Ok(match command {
            command if command.settings_command() => {
                return Err(JobError::new(
                    "settings_session_required",
                    "设置草稿需要原生中心会话",
                ))
            }
            Command::Capabilities => {
                json!({"protocol":2,"library":true,"libraryDelete":true,"videoPosters":true,"import":true,"importFormats":["hwpkg","png","jpeg","webp","mp4","webm"],"nativeFilePicker":true,"settingsDrafts":true,"workDrafts":true,"publicProperties":true,"playlists":true,"playlistMaxItems":32,"export":true,"nativeOutputPicker":true,"builtinPackages":true,"previewBuiltin":true,"mediaApply":true,"previewMedia":true,"settingsSchema":5,"multiDisplay":true,"layouts":["single","span","mirror"],"mirrorBuiltin":false,"mirrorPackages":false,"mirrorPlaylists":false,"mirrorInspection":true,"audioInputs":["none","hertz","system"],"requestBytes":hertz_desktop_ipc::management::REQUEST_LIMIT,"responseBytes":hertz_desktop_ipc::management::RESPONSE_LIMIT})
            }
            Command::PropertiesInspect {
                selection,
                limit,
                cursor,
            } => {
                json!(
                    super::public_properties::inspect(
                        self.jobs().await?,
                        &selection,
                        cursor.as_deref(),
                        limit
                    )
                    .await?
                )
            }
            Command::LayoutInspect { selection, members } => {
                let jobs = Arc::clone(self.jobs().await?);
                self.layout_inspections
                    .observe_import(jobs.active_status().as_ref().map(|job| job.job_id.as_str()));
                let generation = self.layout_inspections.generation();
                let snapshot =
                    match super::selection_plan::layout_snapshot(&jobs, selection, members).await {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            if matches!(
                                error.code,
                                "playlist_not_found" | "version_not_found" | "invalid_input"
                            ) {
                                self.layout_inspections.invalidate();
                            }
                            return Err(error);
                        }
                    };
                let key = snapshot.cache_key();
                match self
                    .layout_inspections
                    .lookup(&key, generation, Instant::now())
                {
                    LayoutLookup::Ready(result) => json!(result?),
                    LayoutLookup::Pending => json!({"pending":true}),
                    LayoutLookup::Busy => {
                        return Err(JobError::new(
                            "budget_busy",
                            "另一项壁纸布局仍在检查，请稍后重试",
                        ))
                    }
                    LayoutLookup::Start { outcome, cancel } => {
                        let permit = match Arc::clone(&self.layout_reader).try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                outcome.finish(Err(JobError::new(
                                    "budget_busy",
                                    "布局检查仍在退出，请稍后重试",
                                )));
                                return Err(JobError::new(
                                    "budget_busy",
                                    "布局检查仍在退出，请稍后重试",
                                ));
                            }
                        };
                        let runtime = tokio::runtime::Handle::current();
                        #[cfg(test)]
                        let worker_gate =
                            self.layout_inspections.worker_gate.lock().unwrap().take();
                        // The coordinator and owned permit, not a polling request, own this
                        // worker. A read timeout cannot restart or release real file I/O.
                        tokio::task::spawn_blocking(move || {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    #[cfg(test)]
                                    if let Some(gate) = worker_gate {
                                        let _ = gate.entered.send(());
                                        let _ = gate.release.recv();
                                    }
                                    runtime.block_on(
                                        super::selection_plan::inspect_layout_snapshot(
                                            &jobs, snapshot, &cancel,
                                        ),
                                    )
                                }))
                                .unwrap_or_else(|_| {
                                    Err(JobError::new("worker_unavailable", "布局检查线程已退出"))
                                });
                            drop(permit);
                            outcome.finish(result);
                        });
                        json!({"pending":true})
                    }
                }
            }
            Command::WorkDraftCreate { document } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .create(document)
                        .await?
                        .receipt()
                )
            }
            Command::PlaylistList { limit, cursor } => {
                json!(
                    super::playlist::Repository::new(self.jobs().await?.library())
                        .list(limit, cursor.as_deref())
                        .await?
                )
            }
            Command::PlaylistGet { playlist_id } => {
                json!(
                    super::playlist::Repository::new(self.jobs().await?.library())
                        .get(&playlist_id)
                        .await?
                )
            }
            Command::PlaylistSave {
                playlist_id,
                expected_playlist_revision,
                title,
                mode,
                interval_seconds,
                items,
            } => {
                self.check_owner(owner)?;
                let jobs = self.jobs().await?;
                let _writer = jobs.assets().content_writer()?;
                if !playlist_properties.is_empty() {
                    let source = Arc::clone(jobs);
                    let references = items.clone();
                    let overrides = playlist_properties.to_vec();
                    let runtime = tokio::runtime::Handle::current();
                    tokio::task::spawn_blocking(move || {
                        runtime.block_on(async {
                            let cancel = AtomicBool::new(false);
                            for properties in &overrides {
                                super::public_properties::validate_references(
                                    &source,
                                    &references,
                                    properties,
                                    &cancel,
                                )
                                .await?;
                            }
                            Ok::<_, JobError>(())
                        })
                    })
                    .await
                    .map_err(|_| {
                        JobError::new("worker_unavailable", "轮播公开属性核验线程已退出")
                    })??;
                }
                json!(
                    super::playlist::Repository::new(jobs.library())
                        .save(
                            playlist_id.as_deref(),
                            expected_playlist_revision,
                            title,
                            mode,
                            interval_seconds,
                            items
                        )
                        .await?
                )
            }
            Command::WorkDraftOpen {
                work_key,
                package_hash,
            } => {
                self.check_owner(owner)?;
                let jobs = self.jobs().await?;
                let _writer = jobs.assets().content_writer()?;
                json!(super::work_drafts::WorkDrafts::new(jobs.library())
                    .create_from_version(&work_key, &package_hash)
                    .await?
                    .receipt())
            }
            Command::WorkDraftList { limit, cursor } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .list(limit, cursor.as_deref())
                        .await?
                )
            }
            Command::WorkDraftGet { draft_id } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .get(&draft_id)
                        .await?
                        .receipt()
                )
            }
            Command::WorkDraftSchema { scene_id } => {
                if !crate::config::wallpaper_scene_allowed(&scene_id) {
                    return Err(JobError::invalid_input("场景不具备桌面资格"));
                }
                hertz_wallpaper::catalog()
                    .scene(&scene_id)
                    .cloned()
                    .ok_or_else(|| JobError::invalid_input("场景不存在"))?
            }
            Command::WorkDraftParameters {
                draft_id,
                draft_revision,
                cursor,
                limit,
            } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .parameters(&draft_id, draft_revision, cursor.as_deref(), limit)
                        .await?
                )
            }
            Command::WorkDraftProperties {
                draft_id,
                draft_revision,
                cursor,
                limit,
            } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .properties(&draft_id, draft_revision, cursor.as_deref(), limit)
                        .await?
                )
            }
            Command::WorkDraftUpdate {
                draft_id,
                draft_revision,
                operations,
            } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .update(&draft_id, draft_revision, operations)
                        .await?
                        .receipt()
                )
            }
            Command::WorkDraftSave {
                draft_id,
                draft_revision,
            } => {
                self.check_owner(owner)?;
                json!(
                    super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                        .save(&draft_id, draft_revision)
                        .await?
                        .receipt()
                )
            }
            Command::WorkDraftDiscard {
                draft_id,
                draft_revision,
            } => {
                self.check_owner(owner)?;
                super::work_drafts::WorkDrafts::new(self.jobs().await?.library())
                    .discard(&draft_id, draft_revision)
                    .await?;
                json!({"discarded":true})
            }
            Command::WorkDraftPublish {
                draft_id,
                draft_revision,
            } => {
                self.check_owner(owner)?;
                let jobs = Arc::clone(self.jobs().await?);
                let runtime = tokio::runtime::Handle::current();
                let published = tokio::task::spawn_blocking(move || {
                    runtime.block_on(super::work_drafts::WorkDrafts::new(jobs.library()).publish(
                        &draft_id,
                        draft_revision,
                        jobs.assets(),
                    ))
                })
                .await
                .map_err(|error| JobError::io(error.to_string()))??;
                json!(published)
            }
            Command::Status => {
                let usage = super::budget::global().usage();
                let active = self
                    .exports
                    .get()
                    .and_then(|jobs| jobs.active_status())
                    .map(|value| json!(value))
                    .or_else(|| {
                        self.jobs
                            .get()
                            .and_then(|jobs| jobs.active_status())
                            .map(|value| json!(value))
                    });
                json!({"decoderSlots":usage.decoder_slots,"prepareTasks":usage.prepare_tasks,"budget":usage,"pendingFileSelection":self.dialog_open.load(Ordering::Acquire),"activeJob":active})
            }
            Command::ExportPick { package_hash } => {
                self.check_owner(owner)?;
                if hwnd == 0 {
                    return Err(JobError::new(
                        "settings_session_required",
                        "请在设置中心选择输出文件",
                    ));
                }
                if self.dialog_open.swap(true, Ordering::AcqRel) {
                    return Err(JobError::new("budget_busy", "文件对话框已打开"));
                }
                struct DialogGuard(Arc<AtomicBool>);
                impl Drop for DialogGuard {
                    fn drop(&mut self) {
                        self.0.store(false, Ordering::Release);
                    }
                }
                let guard = DialogGuard(Arc::clone(&self.dialog_open));
                let name = format!("wallpaper-{}.hwpkg", &package_hash[..12]);
                let selected =
                    tokio::task::spawn_blocking(move || super::output_tokens::pick(hwnd, &name))
                        .await
                        .map_err(|error| JobError::io(error.to_string()))??;
                drop(guard);
                self.check_owner(owner)?;
                match selected {
                    Some(file) => json!(self.output_tokens.issue(
                        owner,
                        package_hash,
                        file,
                        Instant::now()
                    )?),
                    None => json!({"cancelled":true}),
                }
            }
            Command::ExportBegin {
                package_hash,
                output_token,
            } => {
                self.check_owner(owner)?;
                let jobs = self.exports().await?;
                let digest = request.digest();
                if let Some(operation) = jobs.operation(&request.request_id).await? {
                    if operation.payload_digest != digest {
                        return Err(JobError::new(
                            "request_id_conflict",
                            "相同请求 id 对应另一份输入",
                        ));
                    }
                    return Ok(json!({"jobId":operation.job_id}));
                }
                let selected = self.output_tokens.consume(
                    owner,
                    &output_token,
                    &package_hash,
                    Instant::now(),
                )?;
                json!({"jobId":jobs.submit(package_hash, selected, request.request_id.clone(), digest).await?})
            }
            Command::ExportRecover { job_id } => {
                self.check_owner(owner)?;
                let exports = self.exports().await?;
                if exports.persisted_status(&job_id).await?.is_none() {
                    return Err(JobError::new("job_not_found", "导出任务不存在"));
                }
                exports.retry_recovery().await?;
                json!(exports
                    .persisted_status(&job_id)
                    .await?
                    .ok_or_else(|| JobError::new("job_not_found", "导出记录已过期"))?)
            }
            Command::FilePick => {
                self.check_owner(owner)?;
                if hwnd == 0 {
                    return Err(JobError::new(
                        "settings_session_required",
                        "请在设置中心选择文件",
                    ));
                }
                if self.dialog_open.swap(true, Ordering::AcqRel) {
                    return Err(JobError::new("budget_busy", "文件对话框已打开"));
                }
                struct DialogGuard(Arc<AtomicBool>);
                impl Drop for DialogGuard {
                    fn drop(&mut self) {
                        self.0.store(false, Ordering::Release);
                    }
                }
                let guard = DialogGuard(Arc::clone(&self.dialog_open));
                let selected = tokio::task::spawn_blocking(move || file_tokens::pick(hwnd))
                    .await
                    .map_err(|error| JobError::io(error.to_string()))??;
                drop(guard);
                self.check_owner(owner)?;
                match selected {
                    Some(file) => {
                        serde_json::to_value(self.tokens.issue(owner, file, Instant::now())?)
                            .expect("ticket")
                    }
                    None => json!({"cancelled":true}),
                }
            }
            Command::LibraryList {
                limit,
                cursor,
                favorites_only,
            } => {
                let (works, next) = self
                    .jobs()
                    .await?
                    .library()
                    .list_works_filtered(limit, cursor.as_deref(), favorites_only)
                    .await?;
                // 描述在详情读取；列表按最大标题/50 项仍能落在 64 KiB 内。
                let summaries: Vec<Value> = works.into_iter().map(|work| json!({"workKey":work.work_key,"title":work.title,"kind":work.kind,"favorite":work.favorite,"archived":work.archived,"updatedAt":work.updated_at})).collect();
                json!({"works":summaries,"nextCursor":next})
            }
            Command::LibraryGet { work_key } => {
                let library = self.jobs().await?.library();
                let work = library
                    .get_work(&work_key)
                    .await?
                    .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))?;
                json!({"work":work,"versions":library.versions(&work_key).await?})
            }
            Command::LibraryReferences {
                work_key,
                package_hash,
            } => {
                let library = self.jobs().await?.library();
                library
                    .get_work(&work_key)
                    .await?
                    .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))?;
                if let Some(hash) = &package_hash {
                    library.cover_manifest(&work_key, hash).await?;
                }
                let mut report = runtime_references.clone();
                report.extend(
                    super::references::stored(library, &work_key, package_hash.as_deref()).await?,
                );
                json!(report)
            }
            Command::LibraryPoster {
                work_key,
                package_hash,
            } => {
                let jobs = Arc::clone(self.jobs().await?);
                let permit = Arc::clone(&self.poster_reader)
                    .try_acquire_owned()
                    .map_err(|_| JobError::new("budget_busy", "正在读取视频封面，请稍后重试"))?;
                let runtime = tokio::runtime::Handle::current();
                let poster = tokio::task::spawn_blocking(move || {
                    // A query timeout cannot release the reader until the actual I/O exits.
                    let _permit = permit;
                    runtime.block_on(super::video_poster::read(
                        jobs.assets(),
                        jobs.library(),
                        &work_key,
                        &package_hash,
                    ))
                })
                .await
                .map_err(|error| JobError::io(error.to_string()))??;
                json!({"poster":poster})
            }
            Command::LibraryFavorite { work_key, favorite } => {
                let work = self
                    .jobs()
                    .await?
                    .library()
                    .set_favorite(&work_key, favorite)
                    .await?;
                json!({"workKey":work.work_key,"favorite":work.favorite})
            }
            Command::LibraryDeleteWork { work_key } => {
                self.delete_library(work_key, None, None, runtime_references)
                    .await?
            }
            Command::LibraryDeleteVersion {
                work_key,
                version,
                package_hash,
            } => {
                self.delete_library(
                    work_key,
                    Some(i64::from(version)),
                    Some(package_hash),
                    runtime_references,
                )
                .await?
            }
            Command::ImportBegin { file_token } => {
                let jobs = self.jobs().await?;
                let digest = request.digest();
                if let Some(existing) = jobs.library().import_operation(&request.request_id).await?
                {
                    if existing.payload_digest != digest {
                        return Err(JobError::new(
                            "request_id_conflict",
                            "相同请求 id 对应另一份输入",
                        ));
                    }
                    return Ok(json!({"jobId":existing.job_id}));
                }
                self.check_owner(owner)?;
                let file = self.tokens.consume(owner, &file_token, Instant::now())?;
                let job = jobs
                    .submit_authorized(
                        jobs::new_job_id(),
                        file,
                        ImportIdentity {
                            request_id: request.request_id.clone(),
                            payload_digest: digest,
                        },
                    )
                    .await?;
                // Remember the accepted operation immediately so completion between UI
                // polls still changes the observed job identity and invalidates results.
                self.layout_inspections.begin_import(job.clone());
                json!({"jobId":job})
            }
            Command::JobsGet { job_id } => {
                let jobs = self.jobs().await?;
                if let Some(status) = jobs.status(&job_id) {
                    return Ok(json!(status));
                }
                if let Some(status) = self
                    .exports
                    .get()
                    .and_then(|exports| exports.status(&job_id))
                {
                    return Ok(json!(status));
                }
                if let Some(status) =
                    super::export_jobs::persisted_status(jobs.library(), &job_id).await?
                {
                    return Ok(json!(status));
                }
                let status = match jobs.status(&job_id) {
                    Some(status) => Some(status),
                    None => jobs.library().persisted_job(&job_id).await?,
                };
                serde_json::to_value(
                    status.ok_or_else(|| JobError::new("job_not_found", "任务不存在"))?,
                )
                .expect("job status")
            }
            Command::JobsCancel { job_id } => {
                let jobs = self.jobs().await?;
                if jobs.status(&job_id).is_some() {
                    jobs.cancel(&job_id);
                    return Ok(json!({"jobId":job_id,"cancelRequested":true}));
                }
                if self
                    .exports
                    .get()
                    .and_then(|exports| exports.status(&job_id))
                    .is_some()
                    || super::export_jobs::persisted_status(jobs.library(), &job_id)
                        .await?
                        .is_some()
                {
                    if let Some(exports) = self.exports.get() {
                        exports.cancel(&job_id);
                    }
                    return Ok(json!({"jobId":job_id,"cancelRequested":true}));
                }
                if jobs.status(&job_id).is_none()
                    && jobs.library().persisted_job(&job_id).await?.is_none()
                {
                    return Err(JobError::new("job_not_found", "任务不存在"));
                }
                jobs.cancel(&job_id);
                json!({"jobId":job_id,"cancelRequested":true})
            }
            Command::OperationsGet {
                request_id,
                command,
            } => {
                if command.is_none() || command.as_deref() == Some("wallpaper.export.begin") {
                    let jobs = self.jobs().await?;
                    if let Some(operation) =
                        super::export_jobs::operation(jobs.library(), &request_id).await?
                    {
                        let status =
                            super::export_jobs::persisted_status(jobs.library(), &operation.job_id)
                                .await?;
                        return Ok(
                            json!({"requestId":request_id,"jobId":operation.job_id,"job":status}),
                        );
                    }
                }
                if command.is_none()
                    || matches!(
                        command.as_deref(),
                        Some("wallpaper.apply" | "config.commit" | "wallpaper.ai.recommend" | "wallpaper.ai.confirm")
                    )
                {
                    let directory = self.base.clone();
                    let config_request = request_id.clone();
                    let config_operation = tokio::task::spawn_blocking(move || {
                        crate::config::operation_at(&directory, &config_request)
                    })
                    .await
                    .map_err(|_| JobError::new("journal_unavailable", "配置操作查询未完成"))?
                    .map_err(|error| {
                        let code = crate::config_journal::error_code(&error, "config_conflict");
                        JobError::new(code, format!("配置日志不可用：{error:#}"))
                    })?;
                    if let Some(operation) = config_operation.filter(|operation| {
                        command
                            .as_ref()
                            .is_none_or(|command| &operation.command == command)
                    }) {
                        return Ok(
                            serde_json::to_value(operation).expect("configuration operation")
                        );
                    }
                }
                let memory = self
                    .history
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(&request_id)
                    .filter(|record| {
                        command
                            .as_ref()
                            .is_none_or(|command| command == &record.command)
                    })
                    .cloned();
                if let Some(record) = memory {
                    return record
                        .response
                        .ok_or_else(|| JobError::new("operation_pending", "请求仍在处理中"));
                }
                if command
                    .as_deref()
                    .is_some_and(|command| command != "wallpaper.import.begin")
                {
                    return Err(JobError::new(
                        "operation_unknown",
                        "该配置请求无保留记录，请重新读取当前配置",
                    ));
                }
                let jobs = self.jobs().await?;
                let operation = jobs
                    .library()
                    .import_operation(&request_id)
                    .await?
                    .ok_or_else(|| {
                        JobError::new("operation_unknown", "该请求无保留记录，请重新读取库与配置")
                    })?;
                let status = jobs.library().persisted_job(&operation.job_id).await?;
                json!({"requestId":request_id,"jobId":operation.job_id,"job":status})
            }
            _ => return Err(JobError::new("unsupported_command", "当前入口不提供此命令")),
        })
    }

    fn check_owner(&self, owner: u64) -> Result<(), JobError> {
        if !self.tokens.is_owner(owner) {
            Err(JobError::new(
                "settings_session_required",
                "文件能力不属于当前设置会话",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::file_tokens::SelectedFile;
    use super::super::library::tempfileish;
    use super::*;

    #[test]
    fn deletion_and_query_merge_bounded_native_and_persisted_references_before_removing_bytes() {
        let root = tempfileish::temp_dir("service-reference-details");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let jobs = runtime.block_on(service.state.jobs()).unwrap();
        let drafts = super::super::work_drafts::WorkDrafts::new(jobs.library());
        let draft = runtime
            .block_on(drafts.create(super::super::work_drafts::Document {
                title: "引用详情作品".into(),
                description: String::new(),
                scene_id: "coast".into(),
                state_version: 1,
                params: Default::default(),
                properties: vec![],
            }))
            .unwrap();
        runtime
            .block_on(drafts.save(&draft.id, draft.revision))
            .unwrap();
        let published = runtime
            .block_on(drafts.publish(&draft.id, draft.revision, jobs.assets()))
            .unwrap();
        let original = jobs
            .assets()
            .package_dir(&published.package_hash)
            .join("original.hwpkg");
        let bytes = std::fs::read(&original).unwrap();
        let mut native = super::super::references::Report::default();
        native.push(
            "settingsDraft",
            "native-draft",
            "设置草稿",
            "尚未应用的选择",
        );
        let contextual = |request, references| {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            service
                .submit_with_context(request, 0, 0, vec![], references, move |value| {
                    let _ = send.send(value);
                })
                .unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap()
        };
        let query = json!({"workKey":published.work_key,"packageHash":published.package_hash});
        let observed = contextual(
            request("reference-query", "wallpaper.library.references", query),
            native.clone(),
        );
        assert_eq!(observed["ok"], true, "{observed}");
        let kinds = observed["result"]["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"settingsDraft") && kinds.contains(&"workDraft"));
        let delete = json!({"workKey":published.work_key,"version":published.version,"packageHash":published.package_hash});
        let blocked = contextual(
            request(
                "blocked-delete",
                "wallpaper.library.deleteVersion",
                delete.clone(),
            ),
            native,
        );
        assert_eq!(blocked["error"]["code"], "asset_in_use");
        assert_eq!(blocked["error"]["details"], observed["result"]);
        assert_eq!(std::fs::read(&original).unwrap(), bytes);
        let mut mismatch = delete.clone();
        mismatch["packageHash"] = "b".repeat(64).into();
        assert_eq!(
            call(
                &service,
                request(
                    "mismatch-delete",
                    "wallpaper.library.deleteVersion",
                    mismatch
                ),
                0
            )["error"]["code"],
            "version_not_found"
        );
        runtime
            .block_on(drafts.discard(&draft.id, draft.revision))
            .unwrap();
        let clear = call(
            &service,
            request(
                "clear-reference-query",
                "wallpaper.library.references",
                json!({"workKey":published.work_key}),
            ),
            0,
        );
        assert_eq!(clear["result"]["references"], json!([]));
        let removed = call(
            &service,
            request(
                "unreferenced-delete",
                "wallpaper.library.deleteVersion",
                delete,
            ),
            0,
        );
        assert_eq!(removed["ok"], true, "{removed}");
        assert!(!original.exists());
    }

    fn request(id: &str, command: &str, payload: Value) -> Request {
        Request::parse(json!({"protocol":2,"requestId":id,"command":command,"payload":payload}))
            .unwrap()
    }
    fn call(service: &LibraryService, request: Request, owner: u64) -> Value {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        service
            .submit(request, owner, 0, move |value| {
                let _ = send.send(value);
            })
            .unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap()
    }
    fn inspect_until_ready(service: &LibraryService, request: Request) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let reply = call(service, request.clone(), 0);
            if reply["result"]["pending"] != true {
                return reply;
            }
            assert!(
                Instant::now() < deadline,
                "inspection did not finish: {reply}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn probe() -> ProbeClient {
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }))
    }

    #[test]
    fn capabilities_stay_lazy_and_strict_cache_retries_do_not_repeat_effects() {
        let root = tempfileish::temp_dir("service-cache");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let req = request("one", "wallpaper.capabilities", json!({}));
        let first = call(&service, req.clone(), 0);
        assert_eq!(first["ok"], true);
        assert_eq!(first["result"]["requestBytes"], 16384);
        assert_eq!(
            first["result"]["layouts"],
            json!(["single", "span", "mirror"])
        );
        assert_eq!(first["result"]["mirrorInspection"], true);
        for key in ["mirrorBuiltin", "mirrorPackages", "mirrorPlaylists"] {
            assert_eq!(first["result"][key], false);
        }
        assert!(
            !root.path().join("wallpaper.db").exists(),
            "能力查询不初始化存储"
        );
        assert_eq!(first, call(&service, req, 0));
        let conflict = call(&service, request("one", "wallpaper.status", json!({})), 0);
        assert_eq!(conflict["error"]["code"], "request_id_conflict");
        let pick = call(
            &service,
            request("no-owner", "wallpaper.file.pick", json!({})),
            0,
        );
        assert_eq!(pick["error"]["code"], "settings_session_required");
        let unknown = call(
            &service,
            request(
                "unknown",
                "wallpaper.operations.get",
                json!({"requestId":"missing"}),
            ),
            0,
        );
        assert_eq!(unknown["error"]["code"], "operation_unknown");
    }

    #[test]
    fn layout_inspection_is_read_only_and_denies_integrated_sources_without_decode() {
        let root = tempfileish::temp_dir("service-layout-inspect");
        let service = LibraryService::start(
            root.path().to_path_buf(),
            ProbeClient::testing(|_, _| panic!("layout inspection cannot create a decoder")),
        );
        for (index, selection) in [
            json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}}),
            json!({"kind":"followHertz","idleBuiltin":{"sceneId":"coast","stateVersion":1,"params":{}}}),
        ]
        .into_iter()
        .enumerate()
        {
            let reply = inspect_until_ready(
                &service,
                request(
                    &format!("layout-integrated-{index}"),
                    "wallpaper.layout.inspect",
                    json!({"selection":selection,"members":2}),
                ),
            );
            assert_eq!(reply["ok"], true, "{reply}");
            assert_eq!(reply["result"]["layouts"], json!(["single", "span"]));
            assert_eq!(reply["result"]["mirrorEligible"], false);
            assert_eq!(reply["result"]["maxMembers"], 4);
            assert!(reply["result"]["reason"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(reply["jobId"].is_null());
        }
        assert!(service.state.jobs.get().unwrap().active_status().is_none());
    }

    #[test]
    fn layout_poll_survives_query_timeout_without_restarting_or_releasing_reader() {
        let root = tempfileish::temp_dir("service-layout-timeout");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let jobs = runtime.block_on(service.state.jobs()).unwrap();
        let first_connection = runtime.block_on(jobs.library().pool().acquire()).unwrap();
        let second_connection = runtime.block_on(jobs.library().pool().acquire()).unwrap();
        let inspection_request = request(
            "layout-progress",
            "wallpaper.layout.inspect",
            json!({"selection":{"kind":"package","workKey":"missing-work","packageHash":"a".repeat(64)},"members":2}),
        );
        let pending = call(&service, inspection_request.clone(), 0);
        assert_eq!(pending["ok"], true);
        assert_eq!(pending["result"], json!({"pending":true}));
        assert_eq!(service.state.layout_reader.available_permits(), 0);
        let active_outcome = Arc::clone(
            &service
                .state
                .layout_inspections
                .state
                .lock()
                .unwrap()
                .active
                .as_ref()
                .unwrap()
                .outcome,
        );
        let timed_out = call(
            &service,
            request(
                "layout-other-sql-query",
                "wallpaper.layout.inspect",
                json!({"selection":{"kind":"playlist","playlistId":"missing-list"},"members":2}),
            ),
            0,
        );
        assert_eq!(timed_out["error"]["code"], "query_timeout");
        assert_eq!(service.state.layout_reader.available_permits(), 0);
        let started = Instant::now();
        assert_eq!(
            call(&service, inspection_request.clone(), 0)["result"],
            json!({"pending":true})
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        {
            let state = service.state.layout_inspections.state.lock().unwrap();
            let active = state.active.as_ref().unwrap();
            assert!(
                Arc::ptr_eq(&active.outcome, &active_outcome),
                "polls attach to the existing inspection"
            );
            assert!(
                !active.cancel.load(Ordering::Acquire),
                "a polling query timeout does not cancel real work"
            );
        }
        let busy = call(
            &service,
            request(
                "layout-still-running",
                "wallpaper.layout.inspect",
                json!({"selection":{"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}},"members":2}),
            ),
            0,
        );
        assert_eq!(busy["error"]["code"], "budget_busy");
        drop(first_connection);
        drop(second_connection);
        let permit = runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(3),
                Arc::clone(&service.state.layout_reader).acquire_owned(),
            )
            .await
            .unwrap()
            .unwrap()
        });
        drop(permit);
        let completed = inspect_until_ready(&service, inspection_request);
        assert_eq!(completed["error"]["code"], "version_not_found");
        let recovered = inspect_until_ready(
            &service,
            request(
                "layout-after-exit",
                "wallpaper.layout.inspect",
                json!({"selection":{"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}},"members":2}),
            ),
        );
        assert_eq!(recovered["ok"], true, "{recovered}");
        assert_eq!(recovered["result"]["mirrorEligible"], false);
    }

    #[test]
    fn layout_invalidation_keeps_worker_admission_until_physical_exit() {
        let root = tempfileish::temp_dir("service-layout-invalidation");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        runtime.block_on(service.state.jobs()).unwrap();
        let (entered, entered_receive) = std::sync::mpsc::sync_channel(1);
        let (release, release_receive) = std::sync::mpsc::sync_channel(1);
        struct ReleaseOnDrop(std::sync::mpsc::SyncSender<()>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                let _ = self.0.try_send(());
            }
        }
        let _release_on_drop = ReleaseOnDrop(release.clone());
        *service.state.layout_inspections.worker_gate.lock().unwrap() =
            Some(LayoutWorkerTestGate {
                entered,
                release: release_receive,
            });
        let package_request = request(
            "layout-invalidated",
            "wallpaper.layout.inspect",
            json!({"selection":{"kind":"package","workKey":"missing-work","packageHash":"a".repeat(64)},"members":2}),
        );
        assert_eq!(
            call(&service, package_request.clone(), 0)["result"]["pending"],
            true
        );
        entered_receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        service.state.layout_inspections.invalidate();
        assert_eq!(service.state.layout_reader.available_permits(), 0);
        assert_eq!(
            call(&service, package_request, 0)["error"]["code"],
            "budget_busy"
        );
        {
            let state = service.state.layout_inspections.state.lock().unwrap();
            assert!(state
                .active
                .as_ref()
                .unwrap()
                .cancel
                .load(Ordering::Acquire));
        }
        release.send(()).unwrap();
        let permit = runtime.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(3),
                Arc::clone(&service.state.layout_reader).acquire_owned(),
            )
            .await
            .unwrap()
            .unwrap()
        });
        drop(permit);
        let reply = inspect_until_ready(
            &service,
            request(
                "layout-after-invalidation",
                "wallpaper.layout.inspect",
                json!({"selection":{"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}},"members":2}),
            ),
        );
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["result"]["mirrorEligible"], false);
    }

    #[test]
    fn layout_cache_is_bounded_expires_and_retries_failed_results() {
        let root = tempfileish::temp_dir("service-layout-cache");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let reply = inspect_until_ready(
            &service,
            request(
                "layout-value",
                "wallpaper.layout.inspect",
                json!({"selection":{"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}},"members":2}),
            ),
        );
        assert_eq!(reply["ok"], true);
        let value = service
            .state
            .layout_inspections
            .state
            .lock()
            .unwrap()
            .cache
            .front()
            .unwrap()
            .value
            .clone();
        let coordinator = LayoutInspectionCoordinator::new();
        for index in 0..=LAYOUT_CACHE_CAP {
            let key = format!("snapshot-{index}");
            let LayoutLookup::Start { outcome, .. } = coordinator.lookup(&key, 0, Instant::now())
            else {
                panic!("a fresh snapshot starts exactly one task");
            };
            assert!(matches!(
                coordinator.lookup(&key, 0, Instant::now()),
                LayoutLookup::Pending
            ));
            outcome.finish(Ok(value.clone()));
            assert!(matches!(
                coordinator.lookup(&key, 0, Instant::now()),
                LayoutLookup::Ready(Ok(_))
            ));
        }
        assert_eq!(
            coordinator.state.lock().unwrap().cache.len(),
            LAYOUT_CACHE_CAP
        );
        assert!(matches!(
            coordinator.lookup("snapshot-1", 0, Instant::now()),
            LayoutLookup::Ready(Ok(_))
        ));
        assert!(matches!(
            coordinator.lookup(
                "snapshot-1",
                0,
                Instant::now() + LAYOUT_CACHE_TTL + Duration::from_millis(1)
            ),
            LayoutLookup::Start { .. }
        ));
        coordinator.invalidate();
        let active = coordinator
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .outcome
            .clone();
        active.finish(Ok(value));
        let generation = coordinator.generation();
        let LayoutLookup::Start { outcome, .. } =
            coordinator.lookup("failed", generation, Instant::now())
        else {
            panic!("an invalidated success cannot be reused");
        };
        outcome.finish(Err(JobError::new(
            "asset_unavailable",
            "fixture unavailable",
        )));
        assert!(matches!(
            coordinator.lookup("failed", generation, Instant::now()),
            LayoutLookup::Ready(Err(_))
        ));
        assert!(matches!(
            coordinator.lookup("failed", generation, Instant::now()),
            LayoutLookup::Start { .. }
        ));
    }

    #[test]
    fn layout_inspection_ignores_playback_preparation_but_invalidates_import_completion() {
        let coordinator = LayoutInspectionCoordinator::new();
        let LayoutLookup::Start { cancel, .. } =
            coordinator.lookup("long-layout", 0, Instant::now())
        else {
            panic!("start one layout worker");
        };
        coordinator.observe_import(Some("prepare-1"));
        coordinator.observe_import(None);
        coordinator.observe_import(Some("prepare-2"));
        assert_eq!(coordinator.generation(), 0);
        assert!(!cancel.load(Ordering::Acquire));
        assert!(matches!(
            coordinator.lookup("long-layout", 0, Instant::now()),
            LayoutLookup::Pending
        ));
        coordinator.begin_import("import-1".into());
        assert!(cancel.load(Ordering::Acquire));
        let importing = coordinator.generation();
        coordinator.observe_import(Some("import-1"));
        assert_eq!(coordinator.generation(), importing);
        coordinator.observe_import(Some("prepare-after-import"));
        assert_eq!(coordinator.generation(), importing + 1);
    }

    #[test]
    fn layout_cache_binds_playlist_revision_and_mutations_invalidate_completed_results() {
        use crate::wallpaper::{
            config::Selection,
            library::{InstallWork, LOCAL_SOURCE},
            playlist::{FixedVersion, Mode, Repository},
        };
        let root = tempfileish::temp_dir("service-layout-revision");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let jobs = runtime.block_on(service.state.jobs()).unwrap();
        let bytes = crate::wallpaper::work_drafts::builtin_package(
            &crate::wallpaper::work_drafts::Document {
                title: "布局快照".into(),
                description: String::new(),
                scene_id: "coast".into(),
                state_version: 1,
                params: serde_json::Map::new(),
                properties: vec![],
            },
            "c17ed10a-5c55-4a52-85dc-7509f9e88aae",
            1,
        )
        .unwrap();
        let source = root.path().join("layout-source.hwpkg");
        std::fs::write(&source, bytes).unwrap();
        jobs.assets()
            .snapshot_input("layout-source", &source, None)
            .unwrap();
        let package = jobs.assets().validate_staged("layout-source").unwrap();
        jobs.assets()
            .unpack_projection("layout-source", &package)
            .unwrap();
        jobs.assets()
            .content_writer()
            .unwrap()
            .publish_staging("layout-source", &package.package_hash)
            .unwrap();
        let reference = FixedVersion {
            work_key: format!("local-{}", package.manifest.work_id),
            package_hash: package.package_hash.clone(),
        };
        runtime
            .block_on(
                jobs.library().install(&InstallWork {
                    remote_work_id: package.manifest.work_id.clone(),
                    work_key: reference.work_key.clone(),
                    title: package.manifest.title.clone(),
                    description: String::new(),
                    kind: "image".into(),
                    package_hash: package.package_hash.clone(),
                    manifest_json: package.manifest_json,
                    package_bytes: jobs
                        .assets()
                        .installed_bytes(&package.package_hash)
                        .unwrap(),
                    version: 1,
                    source_id: LOCAL_SOURCE.into(),
                }),
            )
            .unwrap();
        let playlist = runtime
            .block_on(Repository::new(jobs.library()).save(
                None,
                None,
                "检查版本".into(),
                Mode::Sequential,
                60,
                vec![reference.clone()],
            ))
            .unwrap();
        let selection = Selection::Playlist {
            playlist_id: playlist.playlist_id.clone(),
        };
        let key_before = runtime
            .block_on(super::super::selection_plan::layout_snapshot(
                jobs,
                selection.clone(),
                2,
            ))
            .unwrap()
            .cache_key();
        let inspection_request = request(
            "layout-same-request",
            "wallpaper.layout.inspect",
            json!({"selection":selection,"members":2}),
        );
        assert_eq!(
            inspect_until_ready(&service, inspection_request.clone())["ok"],
            true
        );
        assert_eq!(
            call(&service, inspection_request.clone(), 0)["result"]["mirrorEligible"],
            false
        );
        assert!(
            service
                .state
                .layout_inspections
                .state
                .lock()
                .unwrap()
                .active
                .is_none(),
            "cached polls do not start a new verifier"
        );

        let changed = runtime
            .block_on(Repository::new(jobs.library()).save(
                Some(&playlist.playlist_id),
                Some(playlist.revision),
                playlist.title,
                playlist.mode,
                playlist.interval_seconds,
                vec![reference.clone()],
            ))
            .unwrap();
        let key_after = runtime
            .block_on(super::super::selection_plan::layout_snapshot(
                jobs, selection, 2,
            ))
            .unwrap()
            .cache_key();
        assert_eq!(changed.revision, playlist.revision + 1);
        assert_ne!(key_before, key_after);
        assert_eq!(
            call(&service, inspection_request.clone(), 0)["result"],
            json!({"pending":true}),
            "a changed revision cannot replay the old receipt or cache entry"
        );
        assert_eq!(
            inspect_until_ready(&service, inspection_request)["ok"],
            true
        );

        let package_request = request(
            "layout-package-cache",
            "wallpaper.layout.inspect",
            json!({"selection":reference.selection(),"members":2}),
        );
        assert_eq!(
            inspect_until_ready(&service, package_request.clone())["ok"],
            true
        );
        let deleted = call(
            &service,
            request(
                "layout-delete-version",
                "wallpaper.library.deleteVersion",
                json!({"workKey":reference.work_key,"version":1,"packageHash":reference.package_hash}),
            ),
            0,
        );
        assert_eq!(
            deleted["error"]["code"], "asset_in_use",
            "even a rejected mutation invalidates observations conservatively"
        );
        assert_eq!(
            call(&service, package_request.clone(), 0)["result"],
            json!({"pending":true})
        );
        assert_eq!(inspect_until_ready(&service, package_request)["ok"], true);
        assert!(jobs.active_status().is_none());
    }

    #[test]
    fn deleting_a_version_removes_the_unreferenced_package_directory_and_rows() {
        use crate::wallpaper::library::{InstallWork, LOCAL_SOURCE};
        let root = tempfileish::temp_dir("service-delete");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let list = call(
            &service,
            request("list", "wallpaper.library.list", json!({})),
            0,
        );
        assert_eq!(list["ok"], true, "初始化作品库");
        let hash = "a".repeat(64);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (library, package_dir) = runtime.block_on(async {
            let library = Library::open(root.path()).await.unwrap();
            library
                .install(&InstallWork {
                    remote_work_id: "uuid-delete".into(),
                    work_key: "key-delete".into(),
                    title: "待删除".into(),
                    description: String::new(),
                    kind: "image".into(),
                    package_hash: hash.clone(),
                    manifest_json: "{}".into(),
                    package_bytes: 70,
                    version: 1,
                    source_id: LOCAL_SOURCE.into(),
                })
                .await
                .unwrap();
            let package_dir = root.path().join("packages").join(&hash);
            std::fs::create_dir_all(&package_dir).unwrap();
            std::fs::write(package_dir.join("original.hwpkg"), b"installed").unwrap();
            (library, package_dir)
        });
        let favorite = call(
            &service,
            request(
                "favorite",
                "wallpaper.library.favorite",
                json!({"workKey":"key-delete","favorite":true}),
            ),
            0,
        );
        assert_eq!(favorite["ok"], true, "{}", favorite["error"]);
        assert_eq!(favorite["result"]["favorite"], 1);
        let filtered = call(
            &service,
            request(
                "favorites",
                "wallpaper.library.list",
                json!({"favoritesOnly":true}),
            ),
            0,
        );
        assert_eq!(filtered["result"]["works"].as_array().unwrap().len(), 1);
        let receipt = call(
            &service,
            request(
                "delete",
                "wallpaper.library.deleteVersion",
                json!({"workKey":"key-delete","version":1,"packageHash":hash}),
            ),
            0,
        );
        assert_eq!(receipt["ok"], true, "{}", receipt["error"]);
        assert_eq!(receipt["result"]["packages"], 1);
        assert!(!package_dir.exists(), "包目录先于库行移除");
        runtime.block_on(async {
            assert!(library.get_work("key-delete").await.unwrap().is_none());
            let packages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
                .fetch_one(library.pool())
                .await
                .unwrap();
            assert_eq!(packages, 0);
        });
    }

    #[test]
    fn pending_configuration_preflight_is_queryable_before_the_commit_intent() {
        let root = tempfileish::temp_dir("service-preflight");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let apply = api::Request::parse(json!({"protocol":2,"requestId":"preflight","command":"wallpaper.apply","expectedRevision":1,"payload":{"draftId":"draft","draftRevision":1}})).unwrap();
        service.begin_local(&apply).unwrap();
        let query = |id| {
            call(
                &service,
                request(
                    id,
                    "wallpaper.operations.get",
                    json!({"requestId":"preflight", "command":"wallpaper.apply"}),
                ),
                0,
            )
        };
        assert_eq!(query("pending-read")["error"]["code"], "operation_pending");
        assert!(
            service.state.jobs.get().is_none(),
            "configuration polling must not open the library"
        );
        let failed = api::response(
            Some("preflight"),
            Err(JobError::new("version_not_found", "missing version")),
            None,
        );
        service.finish_local(&apply, &failed);
        assert_eq!(query("finished-read")["result"], failed);
        assert!(!root.path().join("wallpaper.db").exists());
    }

    #[test]
    fn import_receipt_survives_service_restart_and_cannot_reuse_request_for_another_payload() {
        use sha2::{Digest, Sha256};
        use std::fs::File;
        use std::io::Write;
        let root = tempfileish::temp_dir("service-import");
        let png=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
        let hash = format!("{:x}", Sha256::digest(&png));
        let manifest = json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"本地壁纸","description":"","content":{"kind":"image","asset":"background"},"assets":[{"id":"background","kind":"image","source":"assets/a.png","variants":[]}],"files":[{"path":"assets/a.png","bytes":png.len(),"sha256":hash,"mime":"image/png"}],"properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0","attribution":""}});
        let source = root.path().join("source.hwpkg");
        let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("assets/a.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&png).unwrap();
        zip.finish().unwrap();
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        service.set_settings_owner(1);
        let token = service
            .state
            .tokens
            .issue(1, SelectedFile::open(&source).unwrap(), Instant::now())
            .unwrap();
        let req = request(
            "import-one",
            "wallpaper.import.begin",
            json!({"fileToken":token.file_token}),
        );
        let receipt = call(&service, req.clone(), 1);
        assert_eq!(receipt["ok"], true, "{receipt}");
        let id = receipt["jobId"].as_str().unwrap();
        let mut terminal = Value::Null;
        for n in 0..100 {
            terminal = call(
                &service,
                request(
                    &format!("poll-{n}"),
                    "wallpaper.jobs.get",
                    json!({"jobId":id}),
                ),
                1,
            );
            if terminal["result"]["state"] == "done" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(terminal["result"]["state"], "done", "{terminal}");
        assert_eq!(receipt, call(&service, req.clone(), 1));
        drop(service);
        std::fs::remove_file(source).unwrap();
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let replay = call(&service, req, 0);
        assert_eq!(replay["jobId"], id, "已消耗的令牌不影响持久重试: {replay}");
        let terminal = call(
            &service,
            request("after-restart", "wallpaper.jobs.get", json!({"jobId":id})),
            0,
        );
        assert_eq!(terminal["result"]["state"], "done");
        assert!(terminal["result"]["packageHash"].is_string());
        let conflict = call(
            &service,
            request(
                "import-one",
                "wallpaper.import.begin",
                json!({"fileToken":"a".repeat(32)}),
            ),
            0,
        );
        assert_eq!(conflict["error"]["code"], "request_id_conflict");
        let works = call(
            &service,
            request("list", "wallpaper.library.list", json!({})),
            0,
        );
        assert_eq!(works["result"]["works"].as_array().unwrap().len(), 1);
        let key = works["result"]["works"][0]["workKey"].as_str().unwrap();
        let work = call(
            &service,
            request("detail", "wallpaper.library.get", json!({"workKey":key})),
            0,
        );
        assert_eq!(work["result"]["versions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn raw_media_selected_with_native_token_imports_without_a_path_in_the_request() {
        let root = tempfileish::temp_dir("service-raw");
        let source = root.path().join("本地图片.png");
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
        std::fs::write(&source, png).unwrap();
        let armed = Arc::new(AtomicBool::new(false));
        let release = Arc::new(tokio::sync::Notify::new());
        struct ReleaseOnDrop(Arc<tokio::sync::Notify>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let _release_on_drop = ReleaseOnDrop(Arc::clone(&release));
        let (entered, wait_entered) = std::sync::mpsc::sync_channel(1);
        let (observed, wait_observed) = std::sync::mpsc::sync_channel(1);
        let probe_armed = Arc::clone(&armed);
        let probe_release = Arc::clone(&release);
        let probe = ProbeClient::testing(move |_, cancel| {
            let block = probe_armed.swap(false, Ordering::AcqRel);
            let entered = entered.clone();
            let observed = observed.clone();
            let release = Arc::clone(&probe_release);
            Box::pin(async move {
                if block {
                    entered.send(()).unwrap();
                    while !cancel.load(Ordering::Acquire) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    observed.send(()).unwrap();
                    // A cancelled decoder remains alive until the host acknowledges real exit.
                    release.notified().await;
                    return Err(JobError::new("cancelled", "test decoder exited"));
                }
                Ok(())
            })
        });
        let service = LibraryService::start(root.path().to_path_buf(), probe);
        service.set_settings_owner(7);
        let token = service
            .state
            .tokens
            .issue(7, SelectedFile::open(&source).unwrap(), Instant::now())
            .unwrap();
        let accepted = call(
            &service,
            request(
                "raw-selected",
                "wallpaper.import.begin",
                json!({"fileToken":token.file_token}),
            ),
            7,
        );
        assert_eq!(accepted["ok"], true, "{accepted}");
        let mut job = Value::Null;
        for n in 0..100 {
            job = call(
                &service,
                request(
                    &format!("raw-status-{n}"),
                    "wallpaper.jobs.get",
                    json!({"jobId":accepted["jobId"]}),
                ),
                7,
            );
            if job["result"]["state"] == "done" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(job["result"]["state"], "done", "{job}");
        std::fs::remove_file(source).unwrap();
        let works = call(
            &service,
            request("raw-list", "wallpaper.library.list", json!({})),
            7,
        );
        assert_eq!(works["result"]["works"][0]["title"], "本地图片");
        assert_eq!(works["result"]["works"][0]["kind"], "image");
        assert!(works["result"]["works"][0].get("description").is_none());
        let work_key = works["result"]["works"][0]["workKey"]
            .as_str()
            .unwrap()
            .to_string();
        let package_hash = job["result"]["packageHash"].as_str().unwrap().to_string();
        let target = super::super::image_prepare::ImageTarget {
            width: 41,
            height: 41,
            fit: super::super::image_prepare::ImageFit::Contain,
            purpose: super::super::image_prepare::ImagePurpose::Preview,
        };
        let plan = |work_key: String, cancel: bool| {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            service
                .resolve_selection(
                    super::super::selection_plan::Request {
                        work_key,
                        package_hash: package_hash.clone(),
                        target,
                        properties: Default::default(),
                    },
                    Arc::new(AtomicBool::new(cancel)),
                    move |result| {
                        let _ = send.send(result);
                    },
                )
                .unwrap();
            receive.recv_timeout(Duration::from_secs(5)).unwrap()
        };
        assert_eq!(
            plan("another-work".into(), false).err().unwrap().error.code,
            "version_not_found"
        );
        assert_eq!(
            plan(work_key.clone(), true).err().unwrap().error.code,
            "cancelled"
        );
        armed.store(true, Ordering::Release);
        let cancel = Arc::new(AtomicBool::new(false));
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        service
            .resolve_selection(
                super::super::selection_plan::Request {
                    work_key: work_key.clone(),
                    package_hash: package_hash.clone(),
                    target,
                    properties: Default::default(),
                },
                Arc::clone(&cancel),
                move |result| {
                    let _ = send.send(result);
                },
            )
            .unwrap();
        wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
        cancel.store(true, Ordering::Release);
        wait_observed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            receive.try_recv().is_err(),
            "cancel is not a physical exit receipt"
        );
        assert_eq!(service.pending.load(Ordering::Acquire), 1);
        let jobs = service.state.jobs.get().unwrap();
        assert!(
            jobs.active_status().is_some(),
            "preparation still owns its worker slot"
        );
        // Native planning and formal controls share the same four admission slots.
        let held = (0..3)
            .map(|_| service.reserve().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(service.reserve().err().unwrap().code, "budget_busy");
        release.notify_one();
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .err()
                .unwrap()
                .error
                .code,
            "cancelled"
        );
        assert!(
            jobs.active_status().is_none(),
            "terminal callback follows worker cleanup"
        );
        drop(held);
        let super::super::selection_plan::ResolvedSelection::Media(media) =
            plan(work_key.clone(), false).unwrap()
        else {
            panic!("image work must resolve as media");
        };
        assert_eq!(media.reference().package_hash, package_hash);
        assert_eq!(media.target(), target);
        let key = media.content_key().to_string();
        let super::super::selection_plan::ResolvedSelection::Media(again) =
            plan(work_key, false).unwrap()
        else {
            panic!("image work must resolve as media");
        };
        assert_eq!(
            again.content_key(),
            key,
            "fixed installed bytes prepare once and resolve without the original file"
        );
        assert_eq!(again.url(), media.url());
        assert!(jobs.active_status().is_none());
    }

    #[test]
    fn initialization_outlives_query_deadline_without_blocking_other_controls() {
        let root = tempfileish::temp_dir("service-initialization");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        let library = runtime.block_on(Library::open(root.path())).unwrap();
        let transaction = runtime
            .block_on(library.pool().begin_with("BEGIN IMMEDIATE"))
            .unwrap();
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        service
            .submit(
                request("slow-init", "wallpaper.library.list", json!({})),
                0,
                0,
                move |value| {
                    let _ = send.send(value);
                },
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        assert_eq!(
            call(
                &service,
                request("while-initializing", "wallpaper.capabilities", json!({})),
                0
            )["ok"],
            true
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(3)).unwrap()["error"]["code"],
            "query_timeout"
        );
        runtime.block_on(transaction.rollback()).unwrap();
        assert_eq!(
            call(
                &service,
                request("after-init", "wallpaper.library.list", json!({})),
                0
            )["ok"],
            true
        );
    }

    #[test]
    fn four_pending_queries_hold_admission_until_the_real_sql_completes() {
        let root = tempfileish::temp_dir("service-cap");
        let service = LibraryService::start(root.path().to_path_buf(), probe());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let _entered = runtime.enter();
        let jobs = runtime.block_on(service.state.jobs()).unwrap();
        let a = runtime.block_on(jobs.library().pool().acquire()).unwrap();
        let b = runtime.block_on(jobs.library().pool().acquire()).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        for n in 0..4 {
            let send = send.clone();
            service
                .submit(
                    request(&format!("waiting-{n}"), "wallpaper.library.list", json!({})),
                    0,
                    0,
                    move |value| {
                        let _ = send.send(value);
                    },
                )
                .unwrap();
        }
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(service.pending.load(Ordering::Acquire), 4);
        assert_eq!(
            service
                .submit(
                    request("fifth", "wallpaper.status", json!({})),
                    0,
                    0,
                    |_| {}
                )
                .unwrap_err()
                .code,
            "budget_busy"
        );
        drop(a);
        drop(b);
        for _ in 0..4 {
            assert_eq!(
                receive.recv_timeout(Duration::from_secs(3)).unwrap()["ok"],
                true
            );
        }
    }

    #[test]
    fn trusted_work_export_preserves_package_and_receipt_across_service_restart() {
        use super::super::output_tokens::SelectedOutput;
        use sha2::{Digest, Sha256};
        use std::fs::File;

        let store = tempfileish::temp_dir("service-work-export-store");
        let output = tempfileish::temp_dir("service-work-export-output");
        let destination = output.path().join("saved-work.hwpkg");
        assert!(!destination.starts_with(store.path()));
        let service = LibraryService::start(store.path().to_path_buf(), probe());
        service.set_settings_owner(41);

        let created = call(
            &service,
            request(
                "work-export-create",
                "wallpaper.draft.create",
                json!({"kind":"work","document":{
                    "title":"可导出的海岸","description":"正式管理接口往返",
                    "sceneId":"coast","stateVersion":1,"params":{}
                }}),
            ),
            41,
        );
        assert_eq!(created["ok"], true, "{created}");
        let reference = json!({
            "draftId":created["result"]["draftId"],
            "draftRevision":created["result"]["draftRevision"]
        });
        let saved = call(
            &service,
            request(
                "work-export-save",
                "wallpaper.draft.save",
                reference.clone(),
            ),
            41,
        );
        assert_eq!(saved["ok"], true, "{saved}");
        assert_eq!(saved["result"]["savedRevision"], reference["draftRevision"]);
        let published = call(
            &service,
            request("work-export-publish", "wallpaper.draft.publish", reference),
            41,
        );
        assert_eq!(published["ok"], true, "{published}");
        let hash = published["result"]["packageHash"]
            .as_str()
            .unwrap()
            .to_owned();
        let original = store
            .path()
            .join("packages")
            .join(&hash)
            .join("original.hwpkg");
        let package = hertz_wallpaper::validate_package(File::open(&original).unwrap()).unwrap();
        assert!(matches!(
            package.manifest.content,
            hertz_wallpaper::manifest::Content::Builtin { .. }
        ));
        assert!(package.manifest.files.is_empty());
        let mut archive = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
        assert_eq!(archive.len(), 1, "builtin 包仅包含已规范化的 manifest");
        assert_eq!(archive.by_index(0).unwrap().name(), "manifest.json");
        drop(archive);

        let ticket = service
            .state
            .output_tokens
            .issue(
                41,
                hash.clone(),
                SelectedOutput::open(&destination).unwrap(),
                Instant::now(),
            )
            .unwrap();
        assert!(!destination.exists(), "原生输出选择不能提前创建最终文件");
        let payload = json!({"packageHash":hash,"outputToken":ticket.output_token});
        let denied = call(
            &service,
            request(
                "work-export-no-owner",
                "wallpaper.export.begin",
                payload.clone(),
            ),
            0,
        );
        assert_eq!(denied["error"]["code"], "settings_session_required");
        assert!(
            !destination.exists(),
            "无 owner 请求不能消耗输出能力或写文件"
        );
        for raw_path in [
            destination.to_string_lossy().as_ref(),
            "../outside.hwpkg",
            "https://example.test/work.hwpkg",
        ] {
            for command in ["wallpaper.export.pick", "wallpaper.export.begin"] {
                let mut unsafe_payload = if command.ends_with("begin") {
                    payload.clone()
                } else {
                    json!({"packageHash":hash})
                };
                unsafe_payload["path"] = json!(raw_path);
                assert!(Request::parse(json!({"protocol":2,"requestId":"raw-output-path","command":command,"payload":unsafe_payload})).is_err());
            }
        }

        let export_request = request("work-export-begin", "wallpaper.export.begin", payload);
        let accepted = call(&service, export_request.clone(), 41);
        assert_eq!(accepted["ok"], true, "{accepted}");
        let job_id = accepted["jobId"].as_str().unwrap().to_owned();
        let mut terminal = Value::Null;
        for attempt in 0..100 {
            terminal = call(
                &service,
                request(
                    &format!("work-export-poll-{attempt}"),
                    "wallpaper.jobs.get",
                    json!({"jobId":job_id}),
                ),
                41,
            );
            assert_eq!(terminal["ok"], true, "{terminal}");
            if matches!(
                terminal["result"]["state"].as_str(),
                Some("done" | "failed" | "cancelled")
            ) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(terminal["result"]["state"], "done", "{terminal}");
        assert_eq!(terminal["result"]["kind"], "export");
        assert_eq!(terminal["result"]["packageHash"], hash);
        let bytes = std::fs::read(&destination).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), hash);
        assert_eq!(bytes, std::fs::read(&original).unwrap());
        assert_eq!(
            call(&service, export_request, 41),
            accepted,
            "重复请求返回相同 job，不重新消费 token"
        );
        assert_eq!(
            std::fs::read_dir(output.path()).unwrap().count(),
            1,
            "没有第二份导出或遗留暂存"
        );
        drop(service);

        let restarted = LibraryService::start(store.path().to_path_buf(), probe());
        let recovered = call(
            &restarted,
            request(
                "work-export-after-restart",
                "wallpaper.operations.get",
                json!({
                    "requestId":"work-export-begin","command":"wallpaper.export.begin"
                }),
            ),
            0,
        );
        assert_eq!(recovered["ok"], true, "{recovered}");
        assert_eq!(recovered["result"]["jobId"], job_id);
        assert_eq!(recovered["result"]["job"]["state"], "done");
        assert_eq!(recovered["result"]["job"]["packageHash"], hash);
        assert!(recovered["result"]["job"].get("targetPath").is_none());
        assert!(recovered["result"]["job"].get("temporaryPath").is_none());
        assert_eq!(std::fs::read(destination).unwrap(), bytes);
    }
}
