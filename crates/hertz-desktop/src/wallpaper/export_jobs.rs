// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Bounded, durable exports of immutable original.hwpkg bytes. This worker uses
//! the existing content writer gate; it never prepares or decodes media.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileDispositionInfoEx, FileRenameInfo, GetFileInformationByHandle,
    SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_FLAG_ON_CLOSE, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
    FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_RENAME_INFO,
};

use super::jobs::{ImportJobs, JobError, JobState};
use super::library::{now_secs, Library};
use super::output_tokens::{self, SelectedOutput};

type Result<T> = std::result::Result<T, JobError>;
const HISTORY_CAP: usize = 32;
const RECEIPT_CAP: i64 = 256;
const RECEIPT_TTL: i64 = 600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportStatus {
    pub job_id: String,
    pub kind: &'static str,
    pub state: JobState,
    pub error: Option<String>,
    pub package_hash: String,
    pub staged_bytes: u64,
    pub generation: u64,
    pub name: String,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportOperation {
    pub job_id: String,
    pub payload_digest: String,
    pub package_hash: String,
}

#[derive(sqlx::FromRow)]
struct Row {
    job_id: String,
    package_hash: String,
    name: String,
    state: String,
    bytes: i64,
    generation: i64,
    error: Option<String>,
    target_path: Option<String>,
    temporary_path: Option<String>,
    file_identity: Option<String>,
}

impl Row {
    fn status(&self) -> Result<ExportStatus> {
        Ok(ExportStatus {
            job_id: self.job_id.clone(),
            kind: "export",
            state: serde_json::from_value(serde_json::Value::String(self.state.clone()))
                .map_err(database)?,
            error: self.error.clone(),
            package_hash: self.package_hash.clone(),
            staged_bytes: self.bytes.max(0) as u64,
            generation: self.generation.max(0) as u64,
            name: self.name.clone(),
        })
    }
}

struct Active {
    status: Arc<Mutex<ExportStatus>>,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
struct Inner {
    active: Option<Active>,
    recovering: bool,
    history: VecDeque<ExportStatus>,
}

struct Request {
    status: Arc<Mutex<ExportStatus>>,
    cancel: Arc<AtomicBool>,
    selected: SelectedOutput,
    request_id: String,
    payload_digest: String,
    accepted: tokio::sync::oneshot::Sender<Result<String>>,
}

enum Work {
    Export(Request),
    Recover(tokio::sync::oneshot::Sender<Result<()>>),
}

pub(crate) struct ExportJobs {
    imports: Arc<ImportJobs>,
    inner: Arc<Mutex<Inner>>,
    tx: tokio::sync::mpsc::Sender<Work>,
    generation: AtomicU64,
}

impl ExportJobs {
    /// Recovery and all file I/O run on the dedicated worker, never on the UI
    /// or management runtime. A busy content writer fails without starting work.
    pub(crate) async fn start(imports: Arc<ImportJobs>) -> Result<Self> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Work>(1);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let inner = Arc::new(Mutex::new(Inner::default()));
        let worker_inner = Arc::clone(&inner);
        let worker_imports = Arc::clone(&imports);
        std::thread::Builder::new()
            .name("hertz-wallpaper-export".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(io(error)));
                        return;
                    }
                };
                runtime.block_on(async move {
                    match recover(&worker_imports).await {
                        Ok(()) => {
                            if ready_tx.send(Ok(())).is_err() {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    }
                    while let Some(work) = rx.recv().await {
                        match work {
                            Work::Export(request) => {
                                execute(request, &worker_imports, &worker_inner).await
                            }
                            Work::Recover(reply) => {
                                let result = recover(&worker_imports).await;
                                {
                                    let mut inner = worker_inner.lock().expect("export inner");
                                    // Recovery updates durable receipts, including
                                    // unfinished cleanup of a remembered failure.
                                    // Do not let an older memory result mask it.
                                    inner.history.clear();
                                    inner.recovering = false;
                                }
                                let _ = reply.send(result);
                            }
                        }
                    }
                });
            })
            .map_err(io)?;
        ready_rx
            .await
            .map_err(|_| JobError::new("worker_unavailable", "导出工作线程未启动"))??;
        Ok(Self {
            imports,
            inner,
            tx,
            generation: AtomicU64::new(1),
        })
    }

    pub(crate) async fn submit(
        &self,
        package_hash: String,
        selected: SelectedOutput,
        request_id: String,
        payload_digest: String,
    ) -> Result<String> {
        if !hertz_wallpaper::valid_sha256_hex(&package_hash)
            || !hertz_wallpaper::valid_sha256_hex(&payload_digest)
            || !super::api::valid_id(&request_id)
        {
            return Err(JobError::invalid_input("导出请求标识或摘要无效"));
        }
        if let Some(existing) = self.operation(&request_id).await? {
            return same_operation(existing, &payload_digest, &package_hash);
        }
        let status = Arc::new(Mutex::new(ExportStatus {
            job_id: super::jobs::new_job_id(),
            kind: "export",
            state: JobState::Queued,
            error: None,
            package_hash,
            staged_bytes: 0,
            generation: self.generation.fetch_add(1, Ordering::Relaxed),
            name: selected.name.clone(),
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut inner = self.inner.lock().expect("export inner");
            if inner.active.is_some() || inner.recovering {
                return Err(JobError::new(
                    "budget_busy",
                    "已有导出或恢复任务，请等待文件处理结束",
                ));
            }
            inner.active = Some(Active {
                status: Arc::clone(&status),
                cancel: Arc::clone(&cancel),
            });
        }
        let (accepted, receive) = tokio::sync::oneshot::channel();
        let request = Request {
            status: Arc::clone(&status),
            cancel,
            selected,
            request_id,
            payload_digest,
            accepted,
        };
        if self.tx.try_send(Work::Export(request)).is_err() {
            let mut status = status.lock().expect("export status").clone();
            status.state = JobState::Failed;
            status.error = Some("worker_unavailable: 导出工作线程不可用".into());
            remember(&self.inner, status);
            return Err(JobError::new("worker_unavailable", "导出工作线程不可用"));
        }
        receive
            .await
            .map_err(|_| JobError::new("operation_pending", "导出受理回执丢失，请查询原操作"))?
    }

    /// Retry only the bounded durable recovery set on this same worker. The
    /// native content gate still serializes this with import/delete/recovery.
    /// Dropping an observer does not free the slot before actual I/O exits.
    pub(crate) async fn retry_recovery(&self) -> Result<()> {
        {
            let mut inner = self.inner.lock().expect("export inner");
            if inner.active.is_some() || inner.recovering {
                return Err(JobError::new(
                    "budget_busy",
                    "已有导出或恢复任务，请等待文件处理结束",
                ));
            }
            inner.recovering = true;
        }
        let (reply, receive) = tokio::sync::oneshot::channel();
        if self.tx.try_send(Work::Recover(reply)).is_err() {
            self.inner.lock().expect("export inner").recovering = false;
            return Err(JobError::new("worker_unavailable", "导出工作线程不可用"));
        }
        receive
            .await
            .map_err(|_| JobError::new("operation_pending", "导出恢复回执丢失，请查询原任务"))?
    }

    pub(crate) fn status(&self, job_id: &str) -> Option<ExportStatus> {
        let inner = self.inner.lock().expect("export inner");
        if let Some(active) = &inner.active {
            let status = active.status.lock().expect("export status");
            if status.job_id == job_id {
                return Some(status.clone());
            }
        }
        inner
            .history
            .iter()
            .rev()
            .find(|status| status.job_id == job_id)
            .cloned()
    }
    pub(crate) fn active_status(&self) -> Option<ExportStatus> {
        self.inner
            .lock()
            .expect("export inner")
            .active
            .as_ref()
            .map(|active| active.status.lock().expect("export status").clone())
    }
    pub(crate) fn cancel(&self, job_id: &str) {
        let inner = self.inner.lock().expect("export inner");
        if let Some(active) = &inner.active {
            if active.status.lock().expect("export status").job_id == job_id {
                active.cancel.store(true, Ordering::Release);
            }
        }
    }
    pub(crate) async fn persisted_status(&self, job_id: &str) -> Result<Option<ExportStatus>> {
        persisted_status(self.imports.library(), job_id).await
    }
    pub(crate) async fn operation(&self, request_id: &str) -> Result<Option<ExportOperation>> {
        operation(self.imports.library(), request_id).await
    }
}

fn same_operation(existing: ExportOperation, digest: &str, hash: &str) -> Result<String> {
    if existing.payload_digest != digest || existing.package_hash != hash {
        Err(JobError::new(
            "request_id_conflict",
            "相同请求 id 对应另一份导出内容",
        ))
    } else {
        Ok(existing.job_id)
    }
}

pub(crate) async fn operation(
    library: &Library,
    request_id: &str,
) -> Result<Option<ExportOperation>> {
    sqlx::query_as("SELECT o.job_id,o.payload_digest,j.package_hash FROM export_operations o JOIN export_jobs j ON j.job_id=o.job_id WHERE o.request_id=?1")
        .bind(request_id).fetch_optional(library.pool()).await.map_err(database)
}

pub(crate) async fn persisted_status(
    library: &Library,
    job_id: &str,
) -> Result<Option<ExportStatus>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM export_jobs WHERE job_id=?1")
        .bind(job_id)
        .fetch_optional(library.pool())
        .await
        .map_err(database)?;
    row.map(|row| row.status()).transpose()
}

fn remember(inner: &Mutex<Inner>, status: ExportStatus) {
    let mut inner = inner.lock().expect("export inner");
    inner.history.push_back(status);
    while inner.history.len() > HISTORY_CAP {
        inner.history.pop_front();
    }
    inner.active = None;
}

async fn execute(request: Request, imports: &ImportJobs, inner: &Mutex<Inner>) {
    let Request {
        status,
        cancel,
        selected,
        request_id,
        payload_digest,
        accepted,
    } = request;
    let initial = status.lock().expect("export status").clone();
    let outcome = match imports.assets().content_writer() {
        Ok(_writer) => {
            let accepted_result =
                accept(imports, &initial, &selected, &request_id, &payload_digest).await;
            match accepted_result {
                Ok(Accepted::Existing(job_id)) => {
                    let _ = accepted.send(Ok(job_id));
                    drop(selected);
                    inner.lock().expect("export inner").active = None;
                    return;
                }
                Ok(Accepted::New(temporary)) => {
                    let _ = accepted.send(Ok(initial.job_id.clone()));
                    let result =
                        run(imports, &initial, &status, &cancel, &selected, &temporary).await;
                    // run has closed source and output handles, including deletion
                    // of a partial output. Only then release the native directory pins.
                    drop(selected);
                    let mut terminal = status.lock().expect("export status").clone();
                    match result {
                        Ok(()) => {
                            terminal.state = JobState::Done;
                            terminal.error = None;
                        }
                        Err(error) => {
                            terminal.state = if error.code == "cancelled" {
                                JobState::Cancelled
                            } else {
                                JobState::Failed
                            };
                            terminal.error = Some(format!("{}: {}", error.code, error.message));
                        }
                    }
                    // If an external filesystem failure prevented cleanup, retain
                    // the private recovery record instead of claiming it vanished.
                    let clear =
                        terminal.state == JobState::Done || !temporary.try_exists().unwrap_or(true);
                    if let Err(error) = finish(imports.library(), &terminal, clear).await {
                        crate::app::log(&format!(
                            "wallpaper export receipt deferred: {}",
                            error.code
                        ));
                    }
                    terminal
                }
                Err(error) => {
                    let mut terminal = initial;
                    terminal.state = JobState::Failed;
                    terminal.error = Some(format!("{}: {}", error.code, error.message));
                    let _ = accepted.send(Err(error));
                    terminal
                }
            }
        }
        Err(error) => {
            let mut terminal = initial;
            terminal.state = JobState::Failed;
            terminal.error = Some(format!("{}: {}", error.code, error.message));
            let _ = accepted.send(Err(error));
            terminal
        }
    };
    // Writer and all I/O have really exited before this makes the slot available.
    remember(inner, outcome);
}

enum Accepted {
    Existing(String),
    New(PathBuf),
}

async fn accept(
    imports: &ImportJobs,
    status: &ExportStatus,
    selected: &SelectedOutput,
    request_id: &str,
    digest: &str,
) -> Result<Accepted> {
    if let Some(existing) = operation(imports.library(), request_id).await? {
        return same_operation(existing, digest, &status.package_hash).map(Accepted::Existing);
    }
    let installed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM packages WHERE package_hash=?1 AND state='installed')",
    )
    .bind(&status.package_hash)
    .fetch_one(imports.library().pool())
    .await
    .map_err(database)?;
    if !installed {
        return Err(JobError::new(
            "package_unavailable",
            "指定版本尚未安装或当前不可用",
        ));
    }
    if imports.assets().is_path_within_root(selected.path())? {
        return Err(JobError::new(
            "invalid_output_path",
            "请选择壁纸受管内容库之外的导出位置",
        ));
    }
    output_tokens::ensure_missing(selected.path())?;
    let temporary = selected.path().with_file_name(format!(
        ".hertz-export-{}-{}.part",
        status.job_id,
        super::file_tokens::random_token()?
    ));
    let target_text = selected
        .path()
        .to_str()
        .ok_or_else(|| JobError::invalid_input("导出路径编码无效"))?;
    let temp_text = temporary
        .to_str()
        .ok_or_else(|| JobError::invalid_input("导出路径编码无效"))?;
    let mut tx = imports
        .library()
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(database)?;
    sqlx::query("DELETE FROM export_jobs WHERE state IN ('done','failed','cancelled') AND target_path IS NULL AND updated_at<?1")
        .bind(now_secs() - RECEIPT_TTL).execute(&mut *tx).await.map_err(database)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_jobs")
        .fetch_one(&mut *tx)
        .await
        .map_err(database)?;
    if count >= RECEIPT_CAP {
        return Err(JobError::new(
            "journal_full",
            "导出操作记录已满，请稍后重试",
        ));
    }
    sqlx::query("INSERT INTO export_jobs(job_id,package_hash,name,state,bytes,generation,target_path,temporary_path,updated_at) VALUES (?1,?2,?3,'queued',0,?4,?5,?6,?7)")
        .bind(&status.job_id).bind(&status.package_hash).bind(&status.name).bind(status.generation as i64)
        .bind(target_text).bind(temp_text).bind(now_secs()).execute(&mut *tx).await.map_err(database)?;
    sqlx::query("INSERT INTO export_operations(request_id,payload_digest,job_id,created_at) VALUES (?1,?2,?3,?4)")
        .bind(request_id).bind(digest).bind(&status.job_id).bind(now_secs()).execute(&mut *tx).await.map_err(database)?;
    tx.commit().await.map_err(database)?;
    Ok(Accepted::New(temporary))
}

async fn run(
    imports: &ImportJobs,
    initial: &ExportStatus,
    status: &Mutex<ExportStatus>,
    cancel: &AtomicBool,
    selected: &SelectedOutput,
    temporary_path: &Path,
) -> Result<()> {
    cancelled(cancel)?;
    let mut input = imports
        .assets()
        .open_installed_original(&initial.package_hash)?;
    let expected_bytes = input.metadata().map_err(io)?.len();
    let mut output = Temporary::create(temporary_path)?;
    // Until identity is durable, DELETE_ON_CLOSE removes the temporary even if
    // the process exits. Afterwards recovery owns only this exact file identity.
    sqlx::query(
        "UPDATE export_jobs SET state='preparing',file_identity=?2,updated_at=?3 WHERE job_id=?1",
    )
    .bind(&initial.job_id)
    .bind(&output.identity)
    .bind(now_secs())
    .execute(imports.library().pool())
    .await
    .map_err(database)?;
    output.preserve_on_crash()?;
    status.lock().expect("export status").state = JobState::Preparing;
    let bytes = copy_original(
        &mut input,
        &mut output.file,
        &initial.package_hash,
        cancel,
        |bytes| {
            status.lock().expect("export status").staged_bytes = bytes;
        },
    )?;
    if bytes != expected_bytes {
        return Err(JobError::new("hash_mismatch", "原始壁纸包的大小发生变化"));
    }
    cancelled(cancel)?;
    output.file.sync_all().map_err(io)?;
    sqlx::query("UPDATE export_jobs SET state='publishing',bytes=?2,updated_at=?3 WHERE job_id=?1")
        .bind(&initial.job_id)
        .bind(bytes as i64)
        .bind(now_secs())
        .execute(imports.library().pool())
        .await
        .map_err(database)?;
    status.lock().expect("export status").state = JobState::Publishing;
    cancelled(cancel)?;
    output.commit(selected.path())?;
    // Publication is the commit point. A subsequent cancellation cannot undo it.
    Ok(())
}

fn copy_original(
    input: &mut File,
    output: &mut File,
    hash: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut bytes = 0;
    loop {
        cancelled(cancel)?;
        let count = input.read(&mut buffer).map_err(io)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hertz_wallpaper::archive::check_package_bytes(bytes)?;
        output.write_all(&buffer[..count]).map_err(io)?;
        digest.update(&buffer[..count]);
        progress(bytes);
    }
    if format!("{:x}", digest.finalize()) != hash {
        return Err(JobError::new(
            "hash_mismatch",
            "原始壁纸包的完整摘要与所选版本不一致",
        ));
    }
    Ok(bytes)
}

struct Temporary {
    file: File,
    identity: String,
    committed: bool,
}
impl Temporary {
    fn create(path: &Path) -> Result<Self> {
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(5)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_DELETE_ON_CLOSE)
            .open(path)
            .map_err(io)?;
        let identity = identity(&file)?;
        Ok(Self {
            file,
            identity,
            committed: false,
        })
    }
    fn preserve_on_crash(&self) -> Result<()> {
        // FileDispositionInfo(false) does not clear FILE_FLAG_DELETE_ON_CLOSE.
        // Clear the file object's on-close disposition explicitly (Windows 11).
        let value = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_ON_CLOSE,
        };
        if unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle(),
                FileDispositionInfoEx,
                (&value as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } == 0
        {
            Err(io(std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }
    fn commit(&mut self, target: &Path) -> Result<()> {
        rename_no_replace(&self.file, target)?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.committed {
            let _ = disposition(&self.file, true);
        }
    }
}

fn identity(file: &File) -> Result<String> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks != 1 {
        return Err(JobError::new(
            "invalid_output_path",
            "导出文件不能是链接或共享硬链接",
        ));
    }
    Ok(format!(
        "{:08x}-{:08x}{:08x}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}

fn disposition(file: &File, delete: bool) -> Result<()> {
    let value = FILE_DISPOSITION_INFO { DeleteFile: delete };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&value as *const FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        Err(io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

/// Rename the held file itself, not a path reopened after checking it. Windows
/// enforces ReplaceIfExists=false atomically even if the target appears late.
fn rename_no_replace(file: &File, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    // Include a terminator in the allocation as well as the explicit byte
    // length: the Win32 DOS-path conversion can inspect a trailing WCHAR.
    let length = offset + (name.len() + 1) * 2;
    let mut storage = vec![0usize; length.div_ceil(std::mem::size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            length as u32,
        ) != 0
        {
            return Ok(());
        }
    }
    let error = std::io::Error::last_os_error();
    if matches!(error.raw_os_error(), Some(80 | 183)) {
        Err(JobError::new(
            "target_exists",
            "目标已存在，请选择新的文件名；原文件保持不变",
        ))
    } else {
        Err(io(error))
    }
}

async fn finish(library: &Library, status: &ExportStatus, clear_paths: bool) -> Result<()> {
    let state = match status.state {
        JobState::Done => "done",
        JobState::Cancelled => "cancelled",
        _ => "failed",
    };
    sqlx::query("UPDATE export_jobs SET state=?2,bytes=?3,error=?4,updated_at=?5,target_path=CASE WHEN ?6 THEN NULL ELSE target_path END,temporary_path=CASE WHEN ?6 THEN NULL ELSE temporary_path END,file_identity=CASE WHEN ?6 THEN NULL ELSE file_identity END WHERE job_id=?1")
        .bind(&status.job_id).bind(state).bind(status.staged_bytes as i64).bind(&status.error).bind(now_secs()).bind(clear_paths)
        .execute(library.pool()).await.map_err(database)?;
    Ok(())
}

async fn recover(imports: &ImportJobs) -> Result<()> {
    let _writer = imports.assets().content_writer()?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT * FROM export_jobs WHERE target_path IS NOT NULL ORDER BY updated_at LIMIT 257",
    )
    .fetch_all(imports.library().pool())
    .await
    .map_err(database)?;
    if rows.len() > RECEIPT_CAP as usize {
        return Err(JobError::new("journal_full", "导出恢复记录超过上限"));
    }
    for row in rows {
        let mut status = row.status()?;
        match recover_one(imports, &row) {
            Ok(true) => {
                status.state = JobState::Done;
                status.error = None;
                finish(imports.library(), &status, true).await?;
            }
            Ok(false) => {
                status.state = JobState::Failed;
                status.error = Some(
                    "interrupted: 宿主退出前导出未提交，已清理暂存文件；请重新选择输出位置".into(),
                );
                finish(imports.library(), &status, true).await?;
            }
            Err(error) => {
                // In particular, an exclusively opened final file does not
                // prove publication failed. Preserve the publishing checkpoint
                // so a later recovery can verify the same committed identity.
                sqlx::query("UPDATE export_jobs SET error=?2,updated_at=?3 WHERE job_id=?1")
                    .bind(&status.job_id)
                    .bind(format!("export_recovery_pending: {}", error.message))
                    .bind(now_secs())
                    .execute(imports.library().pool())
                    .await
                    .map_err(database)?;
            }
        }
    }
    Ok(())
}

fn recover_one(imports: &ImportJobs, row: &Row) -> Result<bool> {
    let target = Path::new(
        row.target_path
            .as_deref()
            .ok_or_else(|| JobError::invalid_input("缺少导出恢复目标"))?,
    );
    let selected = SelectedOutput::pin(target, false)?;
    if imports.assets().is_path_within_root(selected.path())? {
        return Err(JobError::invalid_input("导出恢复目标不能位于内容库内"));
    }
    let Some(expected_identity) = &row.file_identity else {
        // Before identity was durable, the OS owned deletion via DELETE_ON_CLOSE.
        return Ok(false);
    };
    if row.state == "publishing" {
        match File::options()
            .read(true)
            .share_mode(1)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(selected.path())
        {
            Ok(mut final_file) => {
                if identity(&final_file)? == *expected_identity {
                    if final_file.metadata().map_err(io)?.len() == row.bytes.max(0) as u64 {
                        let mut digest = Sha256::new();
                        std::io::copy(
                            &mut Read::by_ref(&mut final_file)
                                .take(hertz_wallpaper::MAX_PACKAGE_BYTES + 1),
                            &mut digest,
                        )
                        .map_err(io)?;
                        if format!("{:x}", digest.finalize()) == row.package_hash {
                            return Ok(true);
                        }
                    }
                    return Err(JobError::new(
                        "output_identity_changed",
                        "已提交文件的内容发生变化，无法确认原导出结果",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io(error)),
        }
    }
    let temporary = Path::new(
        row.temporary_path
            .as_deref()
            .ok_or_else(|| JobError::invalid_input("缺少导出暂存记录"))?,
    );
    let prefix = format!(".hertz-export-{}-", row.job_id);
    let suffix = temporary
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(&prefix))
        .and_then(|name| name.strip_suffix(".part"));
    if temporary.parent() != selected.path().parent()
        || !suffix.is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(JobError::invalid_input("导出暂存记录不匹配原输出目录"));
    }
    match File::options()
        .read(true)
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(5)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(temporary)
    {
        Ok(file) => {
            if identity(&file)? != *expected_identity {
                return Err(JobError::new(
                    "output_identity_changed",
                    "暂存文件身份已变化，未修改该文件",
                ));
            }
            disposition(&file, true)?;
            drop(file);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io(error)),
    }
    Ok(false)
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "导出已取消"))
    } else {
        Ok(())
    }
}
fn io(error: impl std::fmt::Display) -> JobError {
    JobError::io(format!("导出文件处理失败：{error}"))
}
fn database(error: impl std::fmt::Display) -> JobError {
    JobError::database(format!("导出记录不可用：{error}"))
}

#[cfg(test)]
mod tests {
    use super::super::library::tempfileish;
    use super::*;

    #[test]
    fn handle_rename_is_atomic_without_overwrite_and_partial_output_is_removed() {
        let root = tempfileish::temp_dir("export-rename");
        let target = root.path().join("output.hwpkg");
        let selected = SelectedOutput::open(&target).unwrap();
        let temporary = root.path().join("first.part");
        let mut output = Temporary::create(&temporary).unwrap();
        output.preserve_on_crash().unwrap();
        output.file.write_all(b"new package").unwrap();
        output.file.sync_all().unwrap();
        let original_identity = output.identity.clone();
        output.commit(selected.path()).unwrap();
        assert_eq!(identity(&output.file).unwrap(), original_identity);
        drop(output);
        assert!(!temporary.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"new package");

        let temporary = root.path().join("second.part");
        let mut output = Temporary::create(&temporary).unwrap();
        output.preserve_on_crash().unwrap();
        output.file.write_all(b"replacement").unwrap();
        assert_eq!(
            output.commit(selected.path()).unwrap_err().code,
            "target_exists"
        );
        drop(output);
        assert!(!temporary.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"new package");
    }

    #[test]
    fn cancellation_during_copy_cleans_only_temporary_and_does_not_publish() {
        let root = tempfileish::temp_dir("export-cancel");
        let source = root.path().join("input");
        let bytes = vec![7u8; 600_000];
        std::fs::write(&source, &bytes).unwrap();
        let mut input = File::open(source).unwrap();
        let temporary = root.path().join("cancel.part");
        let mut output = Temporary::create(&temporary).unwrap();
        output.preserve_on_crash().unwrap();
        let cancel = AtomicBool::new(false);
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let error = copy_original(&mut input, &mut output.file, &hash, &cancel, |_| {
            cancel.store(true, Ordering::Release)
        })
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(output.file.metadata().unwrap().len() < bytes.len() as u64);
        drop(output);
        assert!(!temporary.exists());
        assert!(!root.path().join("output.hwpkg").exists());
    }

    async fn installed(tag: &str) -> (Arc<ImportJobs>, tempfileish::TempDir, String) {
        use super::super::{
            assets::AssetStore,
            decode_probe::ProbeClient,
            work_drafts::{Document, WorkDrafts},
        };
        let root = tempfileish::temp_dir(tag);
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let drafts = WorkDrafts::new(&library);
        let draft = drafts
            .create(Document {
                title: "导出测试".into(),
                description: String::new(),
                scene_id: "coast".into(),
                state_version: 1,
                params: serde_json::Map::new(),
                properties: vec![],
            })
            .await
            .unwrap();
        drafts.save(&draft.id, draft.revision).await.unwrap();
        let published = drafts
            .publish(&draft.id, draft.revision, &assets)
            .await
            .unwrap();
        let imports = Arc::new(ImportJobs::start(
            library,
            assets,
            ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
        ));
        (imports, root, published.package_hash)
    }

    async fn terminal(jobs: &ExportJobs, id: &str) -> ExportStatus {
        for _ in 0..500 {
            let status = jobs.status(id).unwrap();
            if matches!(
                status.state,
                JobState::Done | JobState::Failed | JobState::Cancelled
            ) {
                return status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("export did not complete");
    }

    #[tokio::test]
    async fn export_reimport_preserves_original_hash_and_persistent_request_identity() {
        let (imports, _store, hash) = installed("export-installed-roundtrip").await;
        let root = tempfileish::temp_dir("export-output");
        let target = root.path().join("copy.hwpkg");
        let jobs = ExportJobs::start(Arc::clone(&imports)).await.unwrap();
        let id = jobs
            .submit(
                hash.clone(),
                SelectedOutput::open(&target).unwrap(),
                "export-request".into(),
                "d".repeat(64),
            )
            .await
            .unwrap();
        assert_eq!(terminal(&jobs, &id).await.state, JobState::Done);
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(&target).unwrap())),
            hash
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            std::fs::read(imports.assets().package_dir(&hash).join("original.hwpkg")).unwrap()
        );
        let another = root.path().join("not-written.hwpkg");
        assert_eq!(
            jobs.submit(
                hash.clone(),
                SelectedOutput::open(&another).unwrap(),
                "export-request".into(),
                "d".repeat(64)
            )
            .await
            .unwrap(),
            id
        );
        assert!(!another.exists());
        assert_eq!(
            jobs.submit(
                hash.clone(),
                SelectedOutput::open(&another).unwrap(),
                "export-request".into(),
                "e".repeat(64)
            )
            .await
            .unwrap_err()
            .code,
            "request_id_conflict"
        );
        let restored = ExportJobs::start(Arc::clone(&imports)).await.unwrap();
        assert_eq!(
            restored
                .operation("export-request")
                .await
                .unwrap()
                .unwrap()
                .job_id,
            id
        );
        let receipt = restored.persisted_status(&id).await.unwrap().unwrap();
        assert_eq!(receipt.state, JobState::Done);
        assert!(!serde_json::to_string(&receipt)
            .unwrap()
            .contains("targetPath"));
        let private_paths: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT target_path,temporary_path,file_identity FROM export_jobs WHERE job_id=?1",
        )
        .bind(&id)
        .fetch_one(imports.library().pool())
        .await
        .unwrap();
        assert_eq!(private_paths, (None, None, None));
        let import_id = super::super::jobs::new_job_id();
        imports.submit(import_id.clone(), target).unwrap();
        for _ in 0..500 {
            if matches!(
                imports.status(&import_id).unwrap().state,
                JobState::Done | JobState::Failed | JobState::Cancelled
            ) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(imports.status(&import_id).unwrap().state, JobState::Done);
        assert_eq!(imports.assets().package_dirs(), vec![hash]);
    }

    async fn checkpoint(
        imports: &ImportJobs,
        hash: &str,
        target: &Path,
        publish: bool,
    ) -> (String, PathBuf) {
        let selected = SelectedOutput::open(target).unwrap();
        let status = ExportStatus {
            job_id: super::super::jobs::new_job_id(),
            kind: "export",
            state: JobState::Queued,
            error: None,
            package_hash: hash.to_owned(),
            staged_bytes: 0,
            generation: 1,
            name: selected.name.clone(),
        };
        let Accepted::New(temporary) =
            accept(imports, &status, &selected, &status.job_id, &"d".repeat(64))
                .await
                .unwrap()
        else {
            unreachable!()
        };
        let mut output = Temporary::create(&temporary).unwrap();
        output
            .file
            .write_all(
                &std::fs::read(imports.assets().package_dir(hash).join("original.hwpkg")).unwrap(),
            )
            .unwrap();
        output.file.sync_all().unwrap();
        let bytes = output.file.metadata().unwrap().len();
        sqlx::query(
            "UPDATE export_jobs SET state='publishing',bytes=?2,file_identity=?3 WHERE job_id=?1",
        )
        .bind(&status.job_id)
        .bind(bytes as i64)
        .bind(&output.identity)
        .execute(imports.library().pool())
        .await
        .unwrap();
        output.preserve_on_crash().unwrap();
        if publish {
            output.commit(selected.path()).unwrap();
        }
        // Simulate abrupt process termination after the durable checkpoint by
        // suppressing our normal cancellation cleanup, but close real handles.
        output.committed = true;
        drop(output);
        (status.job_id, temporary)
    }

    #[tokio::test]
    async fn publishing_recovery_waits_for_locked_final_then_confirms_identity() {
        let (imports, _store, hash) = installed("export-installed-locked").await;
        let root = tempfileish::temp_dir("export-recover-locked");
        let target = root.path().join("committed.hwpkg");
        let (id, temporary) = checkpoint(&imports, &hash, &target, true).await;
        assert!(!temporary.exists());
        let locked = File::options()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let jobs = ExportJobs::start(Arc::clone(&imports)).await.unwrap();
        let row: Row = sqlx::query_as("SELECT * FROM export_jobs WHERE job_id=?1")
            .bind(&id)
            .fetch_one(imports.library().pool())
            .await
            .unwrap();
        assert_eq!(row.state, "publishing");
        assert!(row.target_path.is_some() && row.file_identity.is_some());
        assert!(row
            .error
            .as_deref()
            .unwrap()
            .starts_with("export_recovery_pending:"));
        // Repeated explicit recovery while the user still holds the file must
        // keep the commit checkpoint and must not authorize overwriting it.
        jobs.retry_recovery().await.unwrap();
        assert_eq!(
            jobs.persisted_status(&id).await.unwrap().unwrap().state,
            JobState::Publishing
        );
        drop(locked);
        jobs.retry_recovery().await.unwrap();
        let row: Row = sqlx::query_as("SELECT * FROM export_jobs WHERE job_id=?1")
            .bind(&id)
            .fetch_one(imports.library().pool())
            .await
            .unwrap();
        assert_eq!(row.state, "done");
        assert!(row.target_path.is_none() && row.error.is_none());
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(&target).unwrap())),
            hash
        );
    }

    #[tokio::test]
    async fn historical_restore_never_replays_a_valid_old_external_file_identity() {
        let (imports, store, hash) = installed("export-history-revoked").await;
        let external = tempfileish::temp_dir("export-history-external");
        let target = external.path().join("never-published.hwpkg");
        let (id, temporary) = checkpoint(&imports, &hash, &target, false).await;
        let before = std::fs::read(&temporary).unwrap();
        imports.library().pool().close().await;
        drop(imports);
        let mut owner = None;
        for _ in 0..100 {
            match crate::root_owner::RootOwner::exclusive(store.path()) {
                Ok(guard) => {
                    owner = Some(guard);
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            }
        }
        let owner = owner.expect("import worker must retire its root guard");
        let snapshot = hertz_sqlite_lifecycle::create_snapshot(
            owner.root(),
            "external-export-test",
            &crate::wallpaper_upgrade::layout(),
        )
        .await
        .unwrap();
        drop(owner);
        crate::wallpaper_upgrade::maintenance(&[
            "--wallpaper-restore-upgrade-backup".into(),
            snapshot.id,
            "--accept-data-loss".into(),
            "--desktop-root".into(),
            store.path().to_string_lossy().into(),
        ])
        .unwrap();
        let library = Library::open(store.path()).await.unwrap();
        let imports = Arc::new(ImportJobs::start(
            library,
            super::super::assets::AssetStore::new(store.path()).unwrap(),
            super::super::decode_probe::ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
        ));
        let jobs = ExportJobs::start(Arc::clone(&imports)).await.unwrap();
        let receipt = jobs.persisted_status(&id).await.unwrap().unwrap();
        assert_eq!(receipt.state, JobState::Failed);
        assert!(receipt.error.unwrap().contains("database_restored"));
        // Normal export recovery would delete this exact, valid remembered
        // temporary identity. Historical restoration revoked that authority.
        assert_eq!(std::fs::read(&temporary).unwrap(), before);
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn interrupted_temporary_is_cleaned_without_touching_a_racing_destination() {
        let (imports, _store, hash) = installed("export-installed-interrupted").await;
        let root = tempfileish::temp_dir("export-recover-temp");
        let target = root.path().join("never-published.hwpkg");
        let (id, temporary) = checkpoint(&imports, &hash, &target, false).await;
        assert!(temporary.exists());
        std::fs::write(&target, b"someone else's file").unwrap();
        recover(&imports).await.unwrap();
        assert!(!temporary.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"someone else's file");
        let row: Row = sqlx::query_as("SELECT * FROM export_jobs WHERE job_id=?1")
            .bind(&id)
            .fetch_one(imports.library().pool())
            .await
            .unwrap();
        assert_eq!(row.state, "failed");
        assert!(row.target_path.is_none());
    }

    #[tokio::test]
    async fn shared_content_gate_and_managed_paths_and_quarantine_reject_export() {
        let (imports, _store, hash) = installed("export-installed-admission").await;
        let root = tempfileish::temp_dir("export-admission");
        let jobs = ExportJobs::start(Arc::clone(&imports)).await.unwrap();
        let target = root.path().join("result.hwpkg");
        let writer = imports.assets().content_writer().unwrap();
        assert_eq!(jobs.retry_recovery().await.unwrap_err().code, "budget_busy");
        assert_eq!(
            jobs.submit(
                hash.clone(),
                SelectedOutput::open(&target).unwrap(),
                "busy".into(),
                "d".repeat(64)
            )
            .await
            .unwrap_err()
            .code,
            "budget_busy"
        );
        assert!(!target.exists());
        drop(writer);
        // The worker releases the active slot only after its locked branch exits.
        for _ in 0..100 {
            if jobs.active_status().is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        let managed = imports.assets().root().join("forbidden.hwpkg");
        assert_eq!(
            jobs.submit(
                hash.clone(),
                SelectedOutput::open(&managed).unwrap(),
                "managed".into(),
                "d".repeat(64)
            )
            .await
            .unwrap_err()
            .code,
            "invalid_output_path"
        );
        for _ in 0..100 {
            if jobs.active_status().is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        sqlx::query("UPDATE packages SET state='quarantined' WHERE package_hash=?1")
            .bind(&hash)
            .execute(imports.library().pool())
            .await
            .unwrap();
        assert_eq!(
            jobs.submit(
                hash,
                SelectedOutput::open(&target).unwrap(),
                "quarantined".into(),
                "d".repeat(64)
            )
            .await
            .unwrap_err()
            .code,
            "package_unavailable"
        );
        assert!(!target.exists() && !managed.exists());
    }
}
