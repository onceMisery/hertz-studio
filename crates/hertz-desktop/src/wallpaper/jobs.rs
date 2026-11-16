// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 导入任务管理（设计 docs/desktop-wallpaper.md §7.1/§12.1）。
//!
//! 资源准备任务全局一个：同一时刻最多一个活动导入，槽被占时立即返回
//! `budget_busy`（有界等待由调用方决定），不排队大任务。取消只作废代际；
//! 真实 I/O 退出并归还槽之后，任务才算终结（§7.1：「取消后先作废 job
//! generation，待真实 I/O/解码退出才归还槽，不能提前接受第二个大任务」）。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::ops::Deref;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::root_owner::arc_allocation_bytes;
use crate::wallpaper::assets::AssetStore;
use crate::wallpaper::budget::{BudgetCoordinator, ControlCharge, ControlRequest, StatusCharge};
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

/// 单槽已被占用时的原文案。测试用独立字面量钉住它，避免文案漂移；
/// 刻意保持模块私有，避免测试误引用生产常量而让断言恒真。
const BUSY_SLOT_DIAGNOSTIC: &str = "已有导入任务在执行，请等待完成或取消";

/// Status history is a bounded byte owner, not just 32 arbitrary elements.
const STATUS_HISTORY_CAP: usize = 32;
const MAX_STATUS_ID_BYTES: usize = 64;
const MAX_STATUS_ERROR_BYTES: usize = 1024;
/// One retained/cloned status: struct, bounded id/hash/error and allocator
/// slack. Every history entry admits this before it is pushed.
const STATUS_ELEMENT_BYTES: u64 = 4096;
/// Bounded SQLite read for `install_jobs.progress` / `error`; legacy rows can
/// contain arbitrary text, so only these prefixes are materialised.
pub(crate) const MAX_STATUS_DB_READ_CHARS: i64 = 8192;
pub(crate) const MAX_STATUS_DB_ERROR_CHARS: i64 = 1024;
pub(crate) const MAX_STATUS_DB_STATE_CHARS: i64 = 64;

#[cfg(test)]
static STATUS_HISTORY_PEAK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn status_history_peak_for_test() -> usize {
    STATUS_HISTORY_PEAK.load(Ordering::Relaxed)
}

#[cfg(test)]
pub(crate) fn reset_status_history_peak_for_test() {
    STATUS_HISTORY_PEAK.store(0, Ordering::Relaxed);
}

pub(crate) fn bounded_status_error(message: impl Into<String>) -> String {
    let mut message = message.into();
    if message.len() > MAX_STATUS_ERROR_BYTES {
        let mut end = MAX_STATUS_ERROR_BYTES;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.shrink_to_fit();
    }
    message
}

/// Test observation of the actual production worker-frame size queried at the
/// original launch point; it is not a production bound or a cfg(test) oracle.
#[cfg(test)]
static WORKER_FRAME_BYTES: AtomicU64 = AtomicU64::new(0);

/// The shared worker frame is a live inline prepare owner for the whole
/// `ImportJobs` lifetime; tests that assert "everything drained" compare
/// against it instead of zero.
#[cfg(test)]
pub(crate) fn worker_frame_bytes_for_test() -> u64 {
    WORKER_FRAME_BYTES.load(Ordering::Relaxed)
}

const IMPORT_WORKER_NAME: &str = "hertz-wallpaper-import";
/// Prior bounds for the opaque caller-side start allocations. Each has a
/// measured witness in `jobs_tests`; shrinking one below the witness is a test
/// failure, widening needs the witness rerun on both toolchains.
const STARTUP_CHANNEL_SLOTS: u64 = 32;
const STARTUP_CHANNEL_OVERHEAD: u64 = 1024;
const STARTUP_RUNTIME_BOUND: u64 = 64 * 1024;
const STARTUP_PACKET_BOUND: u64 = 1024;

/// A capacity-1 tokio bounded channel still allocates its block granularity of
/// inline `JobRequest` slots plus channel metadata; sizes are known before the
/// channel allocates and are witnessed per toolchain.
pub(crate) fn startup_channel_bytes() -> u64 {
    u64::try_from(std::mem::size_of::<JobRequest>())
        .unwrap_or(u64::MAX)
        .saturating_mul(STARTUP_CHANNEL_SLOTS)
        .saturating_add(STARTUP_CHANNEL_OVERHEAD)
}

/// Conservative prior bound for every caller-side allocation that owns the
/// shared import worker: the four shared Arcs, the capacity-1 request channel,
/// the thread name/spawn packet, the current-thread runtime and the exit Arc.
/// Channel/runtime/packet constants have measured witnesses; the Arc terms are
/// exact type layouts. Worker-thread-internal allocations are not claimed here;
/// the `JoinHandle` join is their physical exit receipt.
pub(crate) fn startup_owner_bytes() -> u64 {
    fn arc_bytes<T>() -> Option<u64> {
        arc_allocation_bytes::<T>()
    }
    let arcs = arc_bytes::<Library>()
        .and_then(|bytes| bytes.checked_add(arc_bytes::<AssetStore>()?))
        .and_then(|bytes| bytes.checked_add(arc_bytes::<Mutex<Inner>>()?))
        .and_then(|bytes| bytes.checked_add(arc_bytes::<AtomicU64>()?))
        .and_then(|bytes| bytes.checked_add(arc_bytes::<AtomicBool>()?));
    let fixed = u64::try_from(IMPORT_WORKER_NAME.len())
        .unwrap_or(u64::MAX)
        .saturating_add(startup_channel_bytes())
        .saturating_add(STARTUP_RUNTIME_BOUND)
        .saturating_add(STARTUP_PACKET_BOUND);
    arcs.unwrap_or(u64::MAX).saturating_add(fixed)
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

impl JobStatus {
    fn set_error(&mut self, message: impl Into<String>) {
        self.error = Some(bounded_status_error(message));
    }
}

/// Upper bound for the JSON text plus the owned `job_id`/`progress`/`error`
/// copies SQLx makes for one persistence write. JSON escaping is at most six
/// bytes per input byte, and the write owns the JSON and the error again.
fn status_write_bytes(status: &JobStatus) -> Option<u64> {
    let strings = u64::try_from(status.job_id.len())
        .ok()?
        .checked_add(u64::try_from(status.error.as_ref().map_or(0, String::len)).ok()?)?
        .checked_add(u64::try_from(status.package_hash.as_ref().map_or(0, String::len)).ok()?)?;
    strings.checked_mul(6)?.checked_mul(2)?.checked_add(1024)
}

#[cfg(test)]
pub(crate) fn status_write_bytes_for_test(status: &JobStatus) -> u64 {
    status_write_bytes(status).unwrap_or(u64::MAX)
}

/// Serialize a status into a pre-sized buffer admitted before any allocation.
/// The returned charge is held across the SQLx write by the caller.
pub(crate) fn status_json(
    budget: &Arc<BudgetCoordinator>,
    status: &JobStatus,
) -> Result<(String, StatusCharge), JobError> {
    let bound = status_write_bytes(status)
        .ok_or_else(|| JobError::new("budget_busy", "状态副本费用计算溢出"))?;
    let charge = budget.admit_status(bound).map_err(|rejection| {
        JobError::new(
            "budget_busy",
            format!("{}: {}", rejection.quota, rejection.message),
        )
    })?;
    let mut json = Vec::with_capacity(usize::try_from(bound).unwrap_or(0));
    serde_json::to_writer(&mut json, status)
        .map_err(|error| JobError::new("status_serialize_failed", error.to_string()))?;
    let json = String::from_utf8(json).expect("serde_json emits UTF-8");
    Ok((json, charge))
}

/// Sanitise a status restored from a legacy row: the requested id is bounded
/// caller input, and every retained field must fit the element bound.
pub(crate) fn sanitize_persisted_status(mut status: JobStatus, job_id: &str) -> Option<JobStatus> {
    if status.job_id != job_id
        || status.job_id.len() > MAX_STATUS_ID_BYTES
        || status
            .package_hash
            .as_ref()
            .is_some_and(|hash| hash.len() != 64)
    {
        return None;
    }
    status.error = status.error.map(bounded_status_error);
    Some(status)
}

/// 已受理任务的返回句柄。id 副本在 clone 前已准入，费用随最后一次销毁退出；
/// 刻意不实现 `Clone`，调用方需要第二个 `String` 时必须自行准入。
pub struct JobId {
    id: String,
    _lease: ControlCharge,
}

impl JobId {
    fn new(id: String, lease: ControlCharge) -> Self {
        Self { id, _lease: lease }
    }
}

impl Deref for JobId {
    type Target = str;

    fn deref(&self) -> &str {
        &self.id
    }
}

impl AsRef<str> for JobId {
    fn as_ref(&self) -> &str {
        &self.id
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.id)
    }
}

impl fmt::Debug for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("JobId").field(&self.id).finish()
    }
}

impl Serialize for JobId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.id)
    }
}

impl PartialEq for JobId {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for JobId {}

impl PartialEq<str> for JobId {
    fn eq(&self, other: &str) -> bool {
        self.id == other
    }
}

impl PartialEq<&str> for JobId {
    fn eq(&self, other: &&str) -> bool {
        self.id == *other
    }
}

impl PartialEq<String> for JobId {
    fn eq(&self, other: &String) -> bool {
        self.id == *other
    }
}

impl PartialEq<JobId> for str {
    fn eq(&self, other: &JobId) -> bool {
        self == other.id
    }
}

impl PartialEq<JobId> for &str {
    fn eq(&self, other: &JobId) -> bool {
        *self == other.id
    }
}

impl PartialEq<JobId> for String {
    fn eq(&self, other: &JobId) -> bool {
        *self == other.id
    }
}

struct ActiveJob {
    status: Arc<Mutex<JobStatus>>,
    cancel: Arc<AtomicBool>,
}

struct StatusEntry {
    status: JobStatus,
    /// Prior fee for this retained element; popped entries refund it.
    _charge: StatusCharge,
}

struct Inner {
    current: Option<ActiveJob>,
    history: std::collections::VecDeque<StatusEntry>,
    budget: Arc<BudgetCoordinator>,
}

impl Inner {
    /// Pop before push so the deque never holds 33 elements, and admit the
    /// element's byte bound before the owned status is retained.
    fn remember(&mut self, status: JobStatus) -> Result<(), JobError> {
        while self.history.len() >= STATUS_HISTORY_CAP {
            self.history.pop_front();
        }
        let charge = self
            .budget
            .admit_status(STATUS_ELEMENT_BYTES)
            .map_err(|rejection| {
                JobError::new(
                    "budget_busy",
                    format!("{}: {}", rejection.quota, rejection.message),
                )
            })?;
        self.history.push_back(StatusEntry {
            status,
            _charge: charge,
        });
        #[cfg(test)]
        STATUS_HISTORY_PEAK.fetch_max(self.history.len(), Ordering::Relaxed);
        Ok(())
    }
}

/// Clears this reservation's single slot if the admitting future is dropped
/// before dispatch. Declared after the request so the slot clear (and the last
/// status/cancel Arc release) happens before the request's control refund.
struct ReservedSlot {
    inner: Arc<Mutex<Inner>>,
    /// Dropped on disarm so a later request refund is the last Arc release.
    status: Option<Arc<Mutex<JobStatus>>>,
    armed: bool,
}

impl ReservedSlot {
    fn new(inner: &Arc<Mutex<Inner>>, status: &Arc<Mutex<JobStatus>>) -> Self {
        Self {
            inner: Arc::clone(inner),
            status: Some(Arc::clone(status)),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.status = None;
    }
}

impl Drop for ReservedSlot {
    fn drop(&mut self) {
        let Some(status) = &self.status else {
            return;
        };
        if !self.armed {
            return;
        }
        let mut guard = self.inner.lock().expect("job inner");
        if guard
            .current
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(&job.status, status))
        {
            guard.current = None;
        }
    }
}

/// 导入任务管理器：单槽 worker 线程（current_thread runtime 跑 sqlx）。
pub struct ImportJobs {
    inner: Arc<Mutex<Inner>>,
    submit_tx: Option<tokio::sync::mpsc::Sender<JobRequest>>,
    generation: Arc<AtomicU64>,
    library: Arc<Library>,
    assets: Arc<AssetStore>,
    /// Same original ledger as the probe reservations; per-request controls,
    /// the shared worker frame and the startup owners are admitted here before
    /// their first allocation.
    budget: Arc<BudgetCoordinator>,
    /// Real thread handle; `Drop` closes the queue and joins it.
    worker: Option<std::thread::JoinHandle<()>>,
    /// Set at the very end of the worker closure after the future frame and the
    /// runtime are gone. Production keeps it as an unqueried receipt; tests use
    /// it to prove the join barrier.
    _worker_exited: Arc<AtomicBool>,
    /// Declared last so the shared Arcs, channel, runtime and spawn packet are
    /// destroyed (and joined) before the startup fee is refunded.
    startup_charge: ControlCharge,
}

impl Drop for ImportJobs {
    fn drop(&mut self) {
        // 关闭请求队列，再等待真实线程退出：runtime、future frame 与 spawn
        // packet 都随线程结束物理消失；join 返回即退出收据，不是 drop 假设。
        drop(self.submit_tx.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
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
    #[cfg(test)]
    model_source_ready: Option<(std::sync::mpsc::Sender<()>, Arc<tokio::sync::Notify>)>,
    /// Typed reply 的事前准入费用；`prepare_*` 在创建 channel 前取走并转成
    /// sender/receiver 共享的 `Arc<ControlCharge>`。
    reply_charge: Option<ControlCharge>,
    /// Declared last so status/cancel/job-id are destroyed before the ledger
    /// refund. The single slot is cleared before the worker drops this request.
    control_charge: ControlCharge,
}

enum JobSource {
    AiReceive {
        native: Arc<super::generation::NativeGeneration>,
        service_job: String,
    },
    ImagePreview(String, super::image_prepare::ImageTarget),
    ImageSave(String, String),
    Import(ImportSource),
    Prepare(super::target_planner::PrepareRequest),
    PrepareFont(FontPrepareRequest),
    PrepareFontGroup(FontGroupPrepareRequest),
    PrepareSvg(SvgPrepareRequest),
    PrepareModelSource(AssetRef),
    PrepareModelInput(AssetRef),
}

/// 固定字体条目和最终文字由原准备 worker 核验；解析事实本身不授予本机资格。
#[derive(Clone)]
pub(crate) struct FontPrepareRequest {
    pub(crate) source: Option<Arc<super::assets::VerifiedPackageSource>>,
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
    pub(crate) source: Option<Arc<super::assets::VerifiedPackageSource>>,
    pub reference: AssetRef,
    pub target: super::image_prepare::ImageTarget,
    pub usage: String,
}

/// 保守上界：Tokio `oneshot::channel::<T>()` 的私有 `Inner<T>` 布局不是 ABI
/// 定理；本值由两个工具链上的实际分配 witness 复核（只许放宽，不许缩小）。
fn reply_bytes<T>() -> u64 {
    let bytes = std::mem::size_of::<Option<T>>()
        .saturating_add(std::mem::size_of::<std::task::Waker>().saturating_mul(2))
        .saturating_add(64);
    u64::try_from(bytes).unwrap_or(u64::MAX)
}

/// typed reply 的总准入字节：oneshot channel 本身加上共享
/// `Arc<ControlCharge>` 的那一次分配。
fn reply_lease_bytes<T>() -> u64 {
    reply_bytes::<T>().saturating_add(arc_allocation_bytes::<ControlCharge>().unwrap_or(u64::MAX))
}

/// sender 与 receiver 共享同一份已准入费用；只有两端都销毁才退款。
struct ReplySender<T> {
    sender: tokio::sync::oneshot::Sender<T>,
    _lease: Arc<ControlCharge>,
}

impl<T> ReplySender<T> {
    fn send(self, value: T) -> Result<(), T> {
        self.sender.send(value)
    }
}

/// 完成回执的接收端包装：poll 委托原 oneshot，费用随最后一个 owner 退出。
pub(crate) struct LeasedReceiver<T> {
    receiver: tokio::sync::oneshot::Receiver<T>,
    _lease: Arc<ControlCharge>,
}

impl<T> LeasedReceiver<T> {
    pub(crate) fn try_recv(&mut self) -> Result<T, tokio::sync::oneshot::error::TryRecvError> {
        self.receiver.try_recv()
    }
}

impl<T> std::future::Future for LeasedReceiver<T> {
    type Output = Result<T, tokio::sync::oneshot::error::RecvError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        // Receiver<T> 与 Arc 都是 Unpin；投影后原样委托原 future。
        let this = self.get_mut();
        Pin::new(&mut this.receiver).poll(context)
    }
}

enum FontPrepareReply {
    AiReceipt(ReplySender<Result<serde_json::Value, JobError>>),
    ModelInput(
        ReplySender<
            Result<super::model_prepare::ModelInput, super::model_prepare::ModelPreparationError>,
        >,
    ),
    ModelSource(ReplySender<Result<super::assets::CanonicalModelSource, JobError>>),
    Media(ReplySender<Result<super::target_planner::ResolvedMedia, JobError>>),
    Single(ReplySender<Result<PreparedFont, JobError>>),
    Group(ReplySender<Result<BTreeMap<String, PreparedFont>, JobError>>),
}

type FontPrepareCompletion<T> = (JobId, LeasedReceiver<Result<T, JobError>>);
type ModelInputCompletion = (
    JobId,
    LeasedReceiver<
        Result<super::model_prepare::ModelInput, super::model_prepare::ModelPreparationError>,
    >,
);

impl FontPrepareReply {
    fn send(
        self,
        outcome: Result<JobOutput, JobError>,
        model_guard: Option<super::model_prepare::ModelErrorGuard>,
    ) {
        if let Self::ModelInput(reply) = self {
            let result = match outcome {
                Ok(JobOutput::ModelInput(input)) => {
                    assert!(model_guard.is_none());
                    Ok(input)
                }
                Err(error) => Err(super::model_prepare::ModelPreparationError::from_parts(
                    error,
                    model_guard,
                )),
                _ => unreachable!("typed model input reply belongs to its source"),
            };
            // A failed send owns and drops the complete input/error+guard.
            let _ = reply.send(result);
            return;
        }
        assert!(
            model_guard.is_none(),
            "model error guard belongs to model input reply"
        );
        match (self, outcome) {
            (Self::AiReceipt(reply), Ok(JobOutput::AiReceipt(value))) => {
                let _ = reply.send(Ok(value));
            }
            (Self::AiReceipt(reply), Err(error)) => {
                let _ = reply.send(Err(error));
            }
            (Self::ModelSource(reply), Ok(JobOutput::ModelSource(source))) => {
                let _ = reply.send(Ok(source));
            }
            (Self::ModelSource(reply), Err(error)) => {
                let _ = reply.send(Err(error));
            }
            (Self::Media(reply), Ok(JobOutput::Media(media))) => {
                let _ = reply.send(Ok(*media));
            }
            (Self::Media(reply), Err(error)) => {
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
    AiReceipt(serde_json::Value),
    ModelInput(super::model_prepare::ModelInput),
    ModelSource(super::assets::CanonicalModelSource),
    Media(Box<super::target_planner::ResolvedMedia>),
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
        let budget = probe.budget_handle();
        // 每一个 caller 侧共享启动 owner 都在第一次分配前取得 prior 费用；
        // 准入失败是 fail-closed 启动错误，不构造“无 worker”的半对象。
        let startup_charge = budget
            .admit_working_bytes(startup_owner_bytes())
            .expect("shared import worker requires startup admission in the prepare quota");
        let library = Arc::new(library);
        let assets = Arc::new(assets);
        // 容量 1：受理即入队；并发受 inner.current 单槽标记约束（busy 即拒）。
        let (tx, rx) = tokio::sync::mpsc::channel::<JobRequest>(1);
        let inner = Arc::new(Mutex::new(Inner {
            current: None,
            history: std::collections::VecDeque::new(),
            budget: Arc::clone(&budget),
        }));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("create wallpaper import runtime");
        // future 在调用线程构造后随 closure 移入 worker；显式 Box 的请求字节
        // 恰为该 size，frame guard 在 block_on 返回后、runtime 销毁前退款。
        let future = worker_loop(
            rx,
            Arc::clone(&inner),
            Arc::clone(&library),
            Arc::clone(&assets),
            probe,
        );
        let frame_bytes = u64::try_from(std::mem::size_of_val(&future))
            .expect("worker frame size fits the original ledger");
        #[cfg(test)]
        WORKER_FRAME_BYTES.store(frame_bytes, Ordering::Relaxed);
        let frame = budget
            .admit_working_bytes(frame_bytes)
            .expect("worker frame requires admission before its Box");
        let future = Box::pin(future);
        let worker_exited = Arc::new(AtomicBool::new(false));
        let exited = Arc::clone(&worker_exited);
        let worker = std::thread::Builder::new()
            .name(IMPORT_WORKER_NAME.into())
            .spawn(move || {
                runtime.block_on(future);
                drop(frame);
                drop(runtime);
                exited.store(true, Ordering::Release);
            })
            .expect("create wallpaper import thread");
        Self {
            inner,
            submit_tx: Some(tx),
            generation: Arc::new(AtomicU64::new(1)),
            library,
            assets,
            budget,
            worker: Some(worker),
            _worker_exited: worker_exited,
            startup_charge,
        }
    }

    /// 物理退出收据：只有 worker 线程在 runtime 与 frame 都销毁后才置位。
    #[cfg(test)]
    pub(crate) fn worker_exited_for_test(&self) -> Arc<AtomicBool> {
        Arc::clone(&self._worker_exited)
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
    pub fn submit(&self, job_id: String, source: PathBuf) -> Result<JobId, JobError> {
        self.submit_for_target(job_id, source, None)
    }

    /// 使用已规划的目标像素准备图片；与普通导入共用槽、取消及原子发布流程。
    pub(crate) fn submit_for_target(
        &self,
        job_id: String,
        source: PathBuf,
        target: Option<super::image_prepare::ImageTarget>,
    ) -> Result<JobId, JobError> {
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
    ) -> Result<JobId, JobError> {
        if let Some(existing) = self.library.import_operation(&identity.request_id).await? {
            if existing.payload_digest != identity.payload_digest {
                return Err(JobError::new(
                    "request_id_conflict",
                    "相同请求 id 对应另一份输入",
                ));
            }
            let bytes = u64::try_from(existing.job_id.len()).unwrap_or(u64::MAX);
            let lease = self
                .budget
                .admit_working_bytes(bytes)
                .map_err(|rejection| {
                    JobError::new(
                        "budget_busy",
                        format!("{}: {}", rejection.quota, rejection.message),
                    )
                })?;
            return Ok(JobId::new(existing.job_id, lease));
        }
        let request = self.reserve(
            job_id,
            JobSource::Import(ImportSource::Pinned(file)),
            None,
            0,
        )?;
        let mut slot = ReservedSlot::new(&self.inner, &request.status);
        let status = request.status.lock().expect("status").clone();
        let accepted = self
            .library
            .accept_import(&status, &identity, &self.budget)
            .await;
        match accepted {
            Ok(accepted) if accepted == request.job_id => {
                // 错误回执路径的第二个 id 副本同样在 clone 前准入；guard 持有到
                // 函数结束。准入失败时 ReservedSlot 仍处于 armed，随 ? 清槽。
                let bytes = u64::try_from(request.job_id.len()).unwrap_or(u64::MAX);
                let _id_lease = self
                    .budget
                    .admit_working_bytes(bytes)
                    .map_err(|rejection| {
                        JobError::new(
                            "budget_busy",
                            format!("{}: {}", rejection.quota, rejection.message),
                        )
                    })?;
                slot.disarm();
                let job_id = request.job_id.clone();
                let result = self.dispatch(request);
                if result.is_err() {
                    if let Some(status) = self.status(&job_id) {
                        let progress = status_json(&self.budget, &status).ok();
                        let written = self
                            .library
                            .record_job(
                                &job_id,
                                None,
                                job_state_db(&status.state),
                                None,
                                progress.as_ref().map(|(json, _)| json.as_str()),
                                status.error.as_deref(),
                            )
                            .await;
                        // SQLx's owned copies live until the execute completes.
                        drop(progress);
                        written?;
                    }
                }
                result
            }
            result => {
                drop(slot);
                let accepted = result?;
                // 并发重试命中已有请求：返回的既有 id 也在交付前准入。
                let bytes = u64::try_from(accepted.len()).unwrap_or(u64::MAX);
                let lease = self
                    .budget
                    .admit_working_bytes(bytes)
                    .map_err(|rejection| {
                        JobError::new(
                            "budget_busy",
                            format!("{}: {}", rejection.quota, rejection.message),
                        )
                    })?;
                Ok(JobId::new(accepted, lease))
            }
        }
    }

    /// TargetPlanner 的缺图请求复用导入 worker；只从已安装固定包准备，不再读取源文件。
    pub(crate) fn prepare_asset(
        &self,
        job_id: String,
        request: super::target_planner::PrepareRequest,
    ) -> Result<JobId, JobError> {
        request.reference.validate()?;
        super::image_prepare::validate_target(Some(request.target))?;
        let target = request.target;
        self.enqueue(job_id, JobSource::Prepare(request), Some(target))
    }

    pub(crate) fn receive_ai(
        &self,
        native: Arc<super::generation::NativeGeneration>,
        service_job: String,
    ) -> Result<FontPrepareCompletion<serde_json::Value>, JobError> {
        if !super::api::valid_id(&service_job) {
            return Err(JobError::invalid_input("生成任务标识无效"));
        }
        let mut request = self.reserve(
            new_job_id(),
            JobSource::AiReceive {
                native,
                service_job,
            },
            None,
            reply_lease_bytes::<Result<serde_json::Value, JobError>>()
                .saturating_add(2 * 1024 * 1024),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::AiReceipt(reply));
        self.dispatch(request).map(|id| (id, receive))
    }

    pub(crate) fn preview_ai_image(
        &self,
        id: String,
        target: super::image_prepare::ImageTarget,
    ) -> Result<FontPrepareCompletion<super::target_planner::ResolvedMedia>, JobError> {
        self.assets.candidate_dir(&id)?;
        super::image_prepare::validate_target(Some(target))?;
        let mut request = self.reserve(
            new_job_id(),
            JobSource::ImagePreview(id, target),
            Some(target),
            reply_lease_bytes::<Result<super::target_planner::ResolvedMedia, JobError>>(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::Media(reply));
        self.dispatch(request).map(|id| (id, receive))
    }

    pub(crate) fn save_ai_image(
        &self,
        id: String,
        title: String,
    ) -> Result<FontPrepareCompletion<serde_json::Value>, JobError> {
        self.assets.candidate_dir(&id)?;
        if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
            return Err(JobError::invalid_input("作品名需为1–120个字符"));
        }
        let mut request = self.reserve(
            new_job_id(),
            JobSource::ImageSave(id, title),
            None,
            reply_lease_bytes::<Result<serde_json::Value, JobError>>()
                .saturating_add(2 * 1024 * 1024),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::AiReceipt(reply));
        self.dispatch(request).map(|id| (id, receive))
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
        let mut request = self.reserve(
            job_id,
            JobSource::PrepareSvg(prepare),
            None,
            reply_lease_bytes::<Result<super::target_planner::ResolvedMedia, JobError>>(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::Media(reply));
        self.dispatch(request).map(|id| (id, receive))
    }
    pub(crate) fn prepare_font(
        &self,
        job_id: String,
        request: FontPrepareRequest,
    ) -> Result<FontPrepareCompletion<PreparedFont>, JobError> {
        request.reference.validate()?;
        let mut request = self.reserve(
            job_id,
            JobSource::PrepareFont(request),
            None,
            reply_lease_bytes::<Result<PreparedFont, JobError>>(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::Single(reply));
        self.dispatch(request).map(|job_id| (job_id, receive))
    }

    /// Installed canonical source/exact variant only; the original typed
    /// worker/terminal guard owns completion. No model/GPU qualification yet.
    pub(crate) fn prepare_model_source(
        &self,
        job_id: String,
        reference: AssetRef,
    ) -> Result<FontPrepareCompletion<super::assets::CanonicalModelSource>, JobError> {
        reference.validate()?;
        let mut request = self.reserve(
            job_id,
            JobSource::PrepareModelSource(reference),
            None,
            reply_lease_bytes::<Result<super::assets::CanonicalModelSource, JobError>>(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::ModelSource(reply));
        self.dispatch(request).map(|id| (id, receive))
    }

    /// Full original checked facts on the canonical installed source. Runtime
    /// qualification is separate; completion uses the original terminal guard.
    pub(crate) fn prepare_model_input(
        &self,
        job_id: String,
        reference: AssetRef,
    ) -> Result<ModelInputCompletion, JobError> {
        reference.validate()?;
        let mut request = self.reserve(
            job_id,
            JobSource::PrepareModelInput(reference),
            None,
            reply_lease_bytes::<
                Result<
                    super::model_prepare::ModelInput,
                    super::model_prepare::ModelPreparationError,
                >,
            >(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::ModelInput(reply));
        self.dispatch(request).map(|id| (id, receive))
    }

    /// One group occupies the original slot through inspection, preflight,
    /// qualification and the same strict terminal database/cancellation guard.
    pub(crate) fn prepare_font_group(
        &self,
        job_id: String,
        request: FontGroupPrepareRequest,
    ) -> Result<FontPrepareCompletion<BTreeMap<String, PreparedFont>>, JobError> {
        request.validate()?;
        let mut request = self.reserve(
            job_id,
            JobSource::PrepareFontGroup(request),
            None,
            reply_lease_bytes::<Result<BTreeMap<String, PreparedFont>, JobError>>(),
        )?;
        let (reply, receive) = self.reply_channel(&mut request);
        request.font_reply = Some(FontPrepareReply::Group(reply));
        self.dispatch(request).map(|job_id| (job_id, receive))
    }

    /// 共享费用的 typed reply channel：`reserve` 已事前准入，channel 创建前
    /// 只做 `Arc` 包装；sender/receiver 各持一份，最后销毁者退款。
    fn reply_channel<T>(&self, request: &mut JobRequest) -> (ReplySender<T>, LeasedReceiver<T>) {
        let charge = request
            .reply_charge
            .take()
            .expect("typed reply admission precedes the original oneshot channel");
        let lease = Arc::new(charge);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (
            ReplySender {
                sender,
                _lease: Arc::clone(&lease),
            },
            LeasedReceiver {
                receiver,
                _lease: lease,
            },
        )
    }

    /// 测试用：held request 直接构造 `JobRequest`，回执仍走生产准入/包装。
    #[cfg(test)]
    fn attach_reply_for_test<T>(
        &self,
        request: &mut JobRequest,
    ) -> (ReplySender<T>, LeasedReceiver<T>) {
        assert!(
            request.reply_charge.is_none(),
            "one typed reply per held request"
        );
        let charge = self
            .budget
            .admit_working_bytes(reply_lease_bytes::<T>())
            .expect("held reply must fit the original prepare quota");
        request.reply_charge = Some(charge);
        self.reply_channel(request)
    }

    fn enqueue(
        &self,
        job_id: String,
        source: JobSource,
        target: Option<super::image_prepare::ImageTarget>,
    ) -> Result<JobId, JobError> {
        let request = self.reserve(job_id, source, target, 0)?;
        self.dispatch(request)
    }

    fn reserve(
        &self,
        job_id: String,
        source: JobSource,
        target: Option<super::image_prepare::ImageTarget>,
        reply_bytes: u64,
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
        // 控制费用只由真实布局与已校验 id 长度决定；布局查询不分配。
        let control = ControlRequest {
            job_id_copy_bytes: u64::try_from(job_id.len()).unwrap_or(u64::MAX),
            status_arc_bytes: arc_allocation_bytes::<Mutex<JobStatus>>().unwrap_or(u64::MAX),
            cancel_arc_bytes: arc_allocation_bytes::<AtomicBool>().unwrap_or(u64::MAX),
        };
        // 单槽判定、控制/回执准入与 status/cancel 构造在同一把 inner 锁内完成：
        // 忙时只产出原静态错误；准入被拒时也不构造任何控制对象。
        // 锁顺序固定 inner → budget（全仓无反向路径）。
        let (status, cancel, reply_charge, control_charge) = {
            let mut guard = self.inner.lock().expect("job inner");
            if guard.current.is_some() {
                // 拒绝路径不在单槽锁内构造错误文字；判定完成后立即放锁。
                drop(guard);
                return Err(JobError::new("budget_busy", BUSY_SLOT_DIAGNOSTIC));
            }
            let control_charge = match self.budget.admit_controls(control) {
                Ok(charge) => charge,
                Err(rejection) => {
                    // 与 decode_probe 的原消费边界一致；先放锁再构造文字。
                    drop(guard);
                    return Err(JobError::new(
                        "budget_busy",
                        format!("{}: {}", rejection.quota, rejection.message),
                    ));
                }
            };
            // typed reply 在提交槽与创建 channel 之前准入；失败时先归还已准入
            // 的控制费用，再放锁返回原 budget_busy 文案。
            let reply_charge = if reply_bytes == 0 {
                None
            } else {
                match self.budget.admit_working_bytes(reply_bytes) {
                    Ok(charge) => Some(charge),
                    Err(rejection) => {
                        drop(control_charge);
                        drop(guard);
                        return Err(JobError::new(
                            "budget_busy",
                            format!("{}: {}", rejection.quota, rejection.message),
                        ));
                    }
                }
            };
            let status = Arc::new(Mutex::new(JobStatus {
                job_id: job_id.clone(),
                state: JobState::Queued,
                error: None,
                package_hash: None,
                staged_bytes: 0,
                generation,
            }));
            let cancel = Arc::new(AtomicBool::new(false));
            guard.current = Some(ActiveJob {
                status: status.clone(),
                cancel: cancel.clone(),
            });
            (status, cancel, reply_charge, control_charge)
        };
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
            #[cfg(test)]
            model_source_ready: None,
            reply_charge,
            control_charge,
        })
    }

    fn dispatch(&self, request: JobRequest) -> Result<JobId, JobError> {
        // 返回 id 的副本在 clone 前准入；拒绝对本请求单槽用同一 guard 清回。
        let id_bytes = u64::try_from(request.job_id.len()).unwrap_or(u64::MAX);
        let lease = match self.budget.admit_working_bytes(id_bytes) {
            Ok(lease) => lease,
            Err(rejection) => {
                drop(ReservedSlot::new(&self.inner, &request.status));
                drop(request);
                return Err(JobError::new(
                    "budget_busy",
                    format!("{}: {}", rejection.quota, rejection.message),
                ));
            }
        };
        let job_id = request.job_id.clone();
        // 槽已在 inner 标记占用；若 worker 已死导致投递失败，这里同步归还槽。
        if let Err(error) = self
            .submit_tx
            .as_ref()
            .expect("worker request channel")
            .try_send(request)
        {
            let request = error.into_inner();
            drop(request.source);
            let mut status = request.status.lock().expect("status").clone();
            status.state = JobState::Failed;
            status.set_error("worker_unavailable: 导入工作线程不可用");
            let mut guard = self.inner.lock().expect("job inner");
            let _ = guard.remember(status);
            guard.current = None;
            return Err(JobError::new("worker_unavailable", "导入工作线程不可用"));
        }
        Ok(JobId::new(job_id, lease))
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
            .find(|entry| entry.status.job_id == job_id)
            .map(|entry| entry.status.clone())
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
        // This owner stays beside the original outcome throughout terminal
        // retries. Moving the factory JobError cannot end its charged lifetime.
        let mut model_error_guard = None;
        let mut outcome = match assets.content_writer() {
            Ok(writer) => {
                let session = format!("prepare-{}-{}", request.job_id, request.generation);
                let preparation = if matches!(
                    &request.source,
                    JobSource::PrepareModelSource(_) | JobSource::PrepareModelInput(_)
                ) {
                    probe.prepare_for_job(session, request.generation)
                } else {
                    probe.prepare(session)
                };
                let outcome = match preparation.as_ref() {
                    Ok(_) => match &request.source {
                        JobSource::AiReceive {
                            native,
                            service_job,
                        } => run_receive_ai(
                            &request,
                            native.clone(),
                            service_job.clone(),
                            &library,
                            &assets,
                            &probe,
                            &writer,
                        )
                        .await
                        .map(JobOutput::AiReceipt),
                        JobSource::ImagePreview(id, target) => {
                            ai_images::preview(&request, id, *target, &library, &assets, &probe)
                                .await
                                .map(|m| JobOutput::Media(Box::new(m)))
                        }
                        JobSource::ImageSave(id, title) => {
                            ai_images::save(&request, id, title, &library, &assets, &probe, &writer)
                                .await
                                .map(JobOutput::AiReceipt)
                        }
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
                                .map(|media| JobOutput::Media(Box::new(media)))
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
                        JobSource::PrepareModelSource(reference) => run_prepare_model_source(
                            &request,
                            reference,
                            &library,
                            &assets,
                            &probe,
                            preparation.as_ref().expect("granted preparation"),
                        )
                        .await
                        .map(JobOutput::ModelSource),
                        JobSource::PrepareModelInput(reference) => match run_prepare_model_input(
                            &request,
                            reference,
                            &library,
                            &assets,
                            &probe,
                            preparation.as_ref().expect("granted preparation"),
                        )
                        .await
                        {
                            Ok(input) => Ok(JobOutput::ModelInput(input)),
                            Err(error) => {
                                let (error, guard) = error.into_parts();
                                model_error_guard = guard;
                                Err(error)
                            }
                        },
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
            if request.font_reply.is_some()
                && outcome.is_ok()
                && !matches!(outcome, Ok(JobOutput::AiReceipt(_)))
            {
                if let Err(error) = cancelled(&request.cancel) {
                    outcome = Err(error);
                }
            }
            let mut status = request.status.lock().expect("status").clone();
            match &outcome {
                Ok(output) => {
                    status.state = JobState::Done;
                    status.package_hash = if matches!(output, JobOutput::AiReceipt(_)) {
                        None
                    } else {
                        Some(match output {
                            JobOutput::AiReceipt(_) => unreachable!(),
                            JobOutput::Package(hash) => hash.clone(),
                            JobOutput::ModelSource(source) => {
                                source.reference().package_hash.clone()
                            }
                            JobOutput::ModelInput(input) => input.reference().package_hash.clone(),
                            JobOutput::Media(media) => media.reference().package_hash.clone(),
                            JobOutput::Font(font) => font.reference().package_hash.clone(),
                            JobOutput::Fonts(fonts) => fonts
                                .values()
                                .next()
                                .expect("nonempty font group")
                                .reference()
                                .package_hash
                                .clone(),
                        })
                    };
                }
                Err(error) if error.code == "cancelled" => {
                    status.state = JobState::Cancelled;
                    status.set_error(error.message.clone());
                }
                Err(error) => {
                    status.state = JobState::Failed;
                    status.set_error(format!("{}: {}", error.code, error.message));
                }
            }
            let progress = status_json(&probe.budget_handle(), &status).ok();
            let terminal = async {
                let result = library
                    .record_job(
                        &status.job_id,
                        None,
                        job_state_db(&status.state),
                        None,
                        progress.as_ref().map(|(json, _)| json.as_str()),
                        status.error.as_deref(),
                    )
                    .await;
                // The owned JSON/error copies live in the SQLx command until
                // this future completes; only then is the prior fee refunded.
                drop(progress);
                result
            };
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
                    status.set_error(format!("{}: {}", error.code, error.message));
                    outcome = Err(error);
                }
            }
            let mut guard = inner.lock().expect("job inner");
            // cancel 与归还原槽共用锁：DB 回执期间收到的取消也不能发成功字体证明。
            if request.font_reply.is_some()
                && outcome.is_ok()
                && !matches!(outcome, Ok(JobOutput::AiReceipt(_)))
                && request.cancel.load(Ordering::Acquire)
            {
                outcome = Err(JobError::new("cancelled", "字体准备已取消并退出"));
                continue;
            }
            let _ = guard.remember(status);
            guard.current = None;
            break;
        }
        if let Some(reply) = request.font_reply {
            reply.send(outcome, model_error_guard);
        } else {
            // No reply: destroy the whole diagnostic/output before its guard.
            drop(outcome);
            if let Some(guard) = model_error_guard {
                guard.finish();
            }
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
async fn run_receive_ai(
    request: &JobRequest,
    native: Arc<super::generation::NativeGeneration>,
    service_job: String,
    library: &Arc<Library>,
    assets: &Arc<AssetStore>,
    probe: &ProbeClient,
    writer: &super::content_quota::Writer<'_>,
) -> Result<serde_json::Value, JobError> {
    cancelled(&request.cancel)?;
    if let Some(existing) = super::ai_receipts::AiReceipts::new(library)
        .existing_job(&service_job)
        .await?
    {
        return Ok(existing);
    }
    assets.check_disk_space(hertz_wallpaper::MAX_IMAGE_BYTES + 64 * 1024)?;
    let staging = assets.staging_dir(&request.job_id);
    std::fs::create_dir(&staging).map_err(|e| JobError::io(e.to_string()))?;
    let source = staging.join("original.hwpkg");
    let cancel = request.cancel.clone();
    let connection = native.clone();
    let received = tokio::task::spawn_blocking(move || {
        connection.receive_artifact(&service_job, &source, &cancel)
    })
    .await
    .map_err(|e| JobError::io(e.to_string()))??;
    cancelled(&request.cancel)?;
    let runtime = tokio::runtime::Handle::current();
    match received {
        super::generation::receive::ReceivedArtifact::Builtin(received) => {
            let epoch = received.epoch;
            let library = Arc::clone(library);
            let cancel = Arc::clone(&request.cancel);
            tokio::task::spawn_blocking(move || {
                runtime.block_on(
                    super::ai_receipts::AiReceipts::new(&library)
                        .receive(received, || native.receive_permit(epoch, &cancel)),
                )
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        super::generation::receive::ReceivedArtifact::Image(received) => {
            let packet = ai_images::receive(request, received, library, assets, probe).await?;
            let bytes = writer.publish_candidate(&request.job_id, &packet.id)?;
            library.ai_receipts_changed.notify_one();
            let library = Arc::clone(library);
            let assets = Arc::clone(assets);
            let cancel = Arc::clone(&request.cancel);
            tokio::task::spawn_blocking(move || {
                let epoch = packet.received.epoch;
                runtime.block_on(super::ai_receipts::AiReceipts::new(&library).receive_image(
                    packet,
                    bytes,
                    &assets,
                    || native.receive_permit(epoch, &cancel),
                ))
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        super::generation::receive::ReceivedArtifact::Composition(received) => {
            ai_compositions::receive(request, received, &native, library, assets, writer).await
        }
    }
}

#[path = "jobs_ai_compositions.rs"]
mod ai_compositions;
#[path = "jobs_ai_images.rs"]
mod ai_images;

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
    install_snapshot(request, receipt, library, assets, probe, writer).await
}

async fn install_snapshot(
    request: &JobRequest,
    receipt: super::assets::SnapshotReceipt,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    writer: &super::content_quota::Writer<'_>,
) -> Result<String, JobError> {
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
    let package = read_prepare_source(
        library,
        assets,
        &prepare.reference.package_hash,
        prepare.source.as_deref(),
    )
    .await?;
    let inputs = assets.probe_source_media(&package, &request.cancel)?;
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
    let package = read_prepare_source(
        library,
        assets,
        &prepare.reference.package_hash,
        prepare.source.as_deref(),
    )
    .await?;
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

async fn run_prepare_model_source(
    request: &JobRequest,
    reference: &AssetRef,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    preparation: &super::decode_probe::Reservation,
) -> Result<super::assets::CanonicalModelSource, JobError> {
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    if !library.is_installed(&reference.package_hash).await? {
        return Err(JobError::new(
            "asset_not_found",
            "canonical model package is not installed/available",
        ));
    }
    #[cfg(test)]
    if let Some(checkpoint) = request.inspection_checkpoint {
        checkpoint(&request.cancel);
    }
    let source =
        assets.pin_canonical_model_source(reference, probe, preparation, &request.cancel)?;
    #[cfg(test)]
    if let Some((entered, release)) = &request.model_source_ready {
        entered.send(()).expect("model source ready observer");
        tokio::time::timeout(std::time::Duration::from_secs(10), release.notified())
            .await
            .expect("model source ready release");
    }
    cancelled(&request.cancel)?;
    Ok(source)
}

// The inline guard retains an already admitted owner without a new Box
// allocation on a rejecting grant. Its actual oneshot layout is tested.
#[allow(clippy::result_large_err)]
async fn run_prepare_model_input(
    request: &JobRequest,
    reference: &AssetRef,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    preparation: &super::decode_probe::Reservation,
) -> Result<super::model_prepare::ModelInput, super::model_prepare::ModelPreparationError> {
    set_state(&request.status, JobState::Preparing);
    cancelled(&request.cancel)?;
    if !library.is_installed(&reference.package_hash).await? {
        return Err(JobError::new(
            "asset_not_found",
            "canonical model package is not installed/available",
        )
        .into());
    }
    #[cfg(test)]
    if let Some(checkpoint) = request.inspection_checkpoint {
        checkpoint(&request.cancel);
    }
    let outcome =
        assets.prepare_canonical_model_input(reference, probe, preparation, &request.cancel);
    #[cfg(test)]
    if let Some((entered, release)) = &request.model_source_ready {
        entered
            .send(())
            .expect("model input outcome ready observer");
        tokio::time::timeout(std::time::Duration::from_secs(10), release.notified())
            .await
            .expect("model input outcome release");
    }
    outcome
}

async fn inspect_font(
    request: &JobRequest,
    prepare: &FontPrepareRequest,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<FontInput, JobError> {
    cancelled(&request.cancel)?;
    read_prepare_source(
        library,
        assets,
        &prepare.reference.package_hash,
        prepare.source.as_deref(),
    )
    .await?;
    // 原准备槽/写门已持有；字体读取、目录核验和解析先取得完整 CPU 工作区。
    let workspace = probe.image_workspace(super::font_prepare::prepare_workspace_bytes(
        prepare.expected_entry.bytes,
    )?)?;
    #[cfg(test)]
    if let Some(checkpoint) = request.inspection_checkpoint {
        checkpoint(&request.cancel);
    }
    let input = super::font_prepare::pin_input_source(
        assets,
        &prepare.reference,
        &prepare.expected_entry,
        &prepare.required_texts,
        &workspace,
        &request.cancel,
        prepare.source.as_deref(),
    );
    // pin_input 同步读取与解析已实际退出，所有成功/错误路径均确认归还工作区。
    workspace.finish();
    input
}

async fn read_prepare_source(
    library: &Library,
    assets: &AssetStore,
    hash: &str,
    source: Option<&super::assets::VerifiedPackageSource>,
) -> Result<super::assets::StagedPackage, JobError> {
    if source.is_none_or(|s| matches!(s.location(), super::assets::PackageLocation::Installed))
        && !library.is_installed(hash).await?
    {
        return Err(JobError::new("asset_not_found", "准备资源已被移除"));
    }
    match source {
        Some(s) => assets.read_source(s),
        None => assets.read_installed_manifest(hash),
    }
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

#[cfg(test)]
#[path = "jobs_model_source_tests.rs"]
mod model_source_tests;

#[cfg(test)]
#[path = "jobs_model_input_tests.rs"]
mod model_input_tests;
