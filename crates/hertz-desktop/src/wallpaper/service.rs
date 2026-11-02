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
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REQUEST_CAP: usize = 4;
const HISTORY_CAP: usize = 256;
const HISTORY_TTL: Duration = Duration::from_secs(600);

type Initialization = Option<Result<(), Arc<JobError>>>;
type Reply = Box<dyn FnOnce(Value) + Send>;
enum Work {
    Command(Call),
    Resolve(ResolveCall),
}
struct ResolveCall {
    request: super::selection_plan::Request,
    cancel: Arc<AtomicBool>,
    reply: Box<dyn FnOnce(Result<super::target_planner::ResolvedMedia, JobError>) + Send>,
    _slot: Slot,
}
struct Call {
    request: Request,
    owner: u64,
    hwnd: isize,
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
    initialization: tokio::sync::OnceCell<tokio::sync::watch::Receiver<Initialization>>,
    tokens: Arc<FileTokens>,
    dialog_open: Arc<AtomicBool>,
    history: Mutex<HashMap<String, Record>>,
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
            initialization: tokio::sync::OnceCell::new(),
            tokens: Arc::new(FileTokens::default()),
            dialog_open: Arc::new(AtomicBool::new(false)),
            history: Mutex::new(HashMap::new()),
        });
        let worker = Arc::clone(&state);
        std::thread::Builder::new().name("hertz-wallpaper-management".into()).spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("wallpaper management runtime");
            tokio::task::LocalSet::new().block_on(&runtime, async move {
                let mut tasks = tokio::task::JoinSet::new();
                loop {
                    worker.tokens.prune(Instant::now());
                    let wake = worker.tokens.next_expiry().unwrap_or_else(|| Instant::now()+Duration::from_secs(3600));
                    tokio::select! {
                        call = rx.recv() => {
                            let Some(call) = call else { break; };
                            let state = Arc::clone(&worker);
                            tasks.spawn_local(async move {
                                match call {
                                    Work::Command(call) => { let _slot = call._slot; let value = state.handle(&call.request, call.owner, call.hwnd).await; (call.reply)(value); }
                                    Work::Resolve(call) => {
                                        let _slot = call._slot;
                                        let result = if call.cancel.load(Ordering::Acquire) { Err(JobError::new("cancelled", "媒体选择已取消")) } else { match state.jobs().await {
                                            Ok(jobs) => super::selection_plan::resolve(Arc::clone(jobs), call.request, call.cancel).await,
                                            Err(error) => Err(error),
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
    }

    pub(crate) fn submit(
        &self,
        request: Request,
        owner: u64,
        hwnd: isize,
        reply: impl FnOnce(Value) + Send + 'static,
    ) -> Result<(), JobError> {
        let slot = self.reserve()?;
        let call = Call {
            request,
            owner,
            hwnd,
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
        reply: impl FnOnce(Result<super::target_planner::ResolvedMedia, JobError>) + Send + 'static,
    ) -> Result<(), JobError> {
        let slot = self.reserve()?;
        self.resolve_selection_reserved(request, cancel, slot, reply)
    }

    pub(crate) fn resolve_selection_reserved(
        &self,
        request: super::selection_plan::Request,
        cancel: Arc<AtomicBool>,
        slot: Slot,
        reply: impl FnOnce(Result<super::target_planner::ResolvedMedia, JobError>) + Send + 'static,
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
    }
}

impl State {
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
                            let _ = state.jobs.set(jobs);
                            Ok(())
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
            return record.response.clone().map(Some).ok_or_else(|| {
                JobError::new("operation_pending", "请求仍在处理，请按 requestId 查询")
            });
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

    async fn handle(self: &Arc<Self>, request: &Request, owner: u64, hwnd: isize) -> Value {
        match self.begin_request(request) {
            Ok(Some(value)) => return value,
            Err(error) => return api::response(Some(&request.request_id), Err(error), None),
            Ok(None) => {}
        }
        let read_only = matches!(
            request.typed(),
            Ok(Command::Capabilities
                | Command::Status
                | Command::LibraryList { .. }
                | Command::LibraryGet { .. }
                | Command::JobsGet { .. }
                | Command::OperationsGet { .. })
        );
        let result = if read_only {
            tokio::time::timeout(Duration::from_secs(2), self.execute(request, owner, hwnd))
                .await
                .unwrap_or_else(|_| {
                    Err(JobError::new(
                        "query_timeout",
                        "查询超过期限，请按新的请求重新读取",
                    ))
                })
        } else {
            self.execute(request, owner, hwnd).await
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
    ) -> Result<Value, JobError> {
        Ok(match request.typed()? {
            command if command.settings_command() => {
                return Err(JobError::new(
                    "settings_session_required",
                    "设置草稿需要原生中心会话",
                ))
            }
            Command::Capabilities => {
                json!({"protocol":2,"library":true,"import":true,"importFormats":["hwpkg","png","jpeg","webp","mp4","webm"],"nativeFilePicker":true,"settingsDrafts":true,"previewBuiltin":true,"mediaApply":true,"previewMedia":true,"settingsSchema":5,"layouts":["single"],"audioInputs":["none","hertz","system"],"requestBytes":hertz_desktop_ipc::management::REQUEST_LIMIT,"responseBytes":hertz_desktop_ipc::management::RESPONSE_LIMIT})
            }
            Command::Status => {
                let usage = super::budget::global().usage();
                json!({"decoderSlots":usage.decoder_slots,"prepareTasks":usage.prepare_tasks,"pendingFileSelection":self.dialog_open.load(Ordering::Acquire),"activeJob":self.jobs.get().and_then(|jobs| jobs.active_status())})
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
            Command::LibraryList { limit, cursor } => {
                let (works, next) = self
                    .jobs()
                    .await?
                    .library()
                    .list_works(limit, cursor.as_deref())
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
                json!({"jobId":job})
            }
            Command::JobsGet { job_id } => {
                let jobs = self.jobs().await?;
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
                if command.as_deref() != Some("wallpaper.import.begin") {
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
        assert_eq!(replay["jobId"], id, "已消耗的令牌不影响持久重试");
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
            plan("another-work".into(), false).err().unwrap().code,
            "version_not_found"
        );
        assert_eq!(
            plan(work_key.clone(), true).err().unwrap().code,
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
                .code,
            "cancelled"
        );
        assert!(
            jobs.active_status().is_none(),
            "terminal callback follows worker cleanup"
        );
        drop(held);
        let media = plan(work_key.clone(), false).unwrap();
        assert_eq!(media.reference().package_hash, package_hash);
        assert_eq!(media.target(), target);
        let key = media.content_key().to_string();
        let again = plan(work_key, false).unwrap();
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
}
