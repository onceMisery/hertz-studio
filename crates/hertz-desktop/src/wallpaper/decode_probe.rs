// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! §7.1 第二道准入：受信、可独立关闭的可见 WebView2 解码容器。
//! worker 只发送已固定字节；UI 不打开文件。回执在 controller Close 成功、
//! Broker 撤销且所有真实文件活动退出后发送，取消/期限都不提前释放配额。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder, WindowId};
use tokio::sync::oneshot;
use wry::{WebContext, WebView, WebViewBuilder, WebViewExtWindows};

use super::access::{Drain, MediaAccess};
use super::assets::DecodeInput;
use super::budget::global as global_budget;
use super::budget::{BudgetCoordinator, BudgetRequest, OwnerKind};
use super::font_prepare::FontInput;
use super::jobs::JobError;
use super::media::{Container, MediaProbe};
use crate::app::UserEvent;
use crate::native_events::EventLoopProxy;

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
use super::istream::read_probe::{
    HostDropGuard, ReadControl, ReadGate, ReadOwner, ReadProbeSnapshot, ReleaseReason,
};

const PROBE_LIMIT: Duration = Duration::from_secs(15);
const REPORT_LIMIT: usize = 40 * 1024;
static NEXT_PROBE: AtomicU64 = AtomicU64::new(1);

/// Drop 仅标记 release，不能证明物理退出。调用方必须在清理屏障后 finish。
pub(crate) struct Reservation {
    budget: Arc<BudgetCoordinator>,
    request: BudgetRequest,
    token: u64,
    release_on_drop: bool,
}

impl Reservation {
    fn grant(budget: Arc<BudgetCoordinator>, request: BudgetRequest) -> Result<Self, JobError> {
        let token = budget.grant(&request).map_err(|error| {
            JobError::new("budget_busy", format!("{}: {}", error.quota, error.message))
        })?;
        Ok(Self {
            budget,
            request,
            token,
            release_on_drop: true,
        })
    }

    pub(crate) fn prepare(
        budget: Arc<BudgetCoordinator>,
        session: String,
    ) -> Result<Self, JobError> {
        let mut request = empty_request(session);
        request.prepare_tasks = 1;
        Self::grant(budget, request)
    }

    fn release(&self) {
        let _ = self
            .budget
            .release(self.token, &self.request.session, self.request.generation);
    }

    pub(crate) fn finish(mut self) {
        self.release();
        // Only granted, bounded identities enter this owner. Keep identity on
        // the stack while its caller String backings exit under pending quota.
        let mut session = [0_u8; 128];
        let len = self.request.session.len();
        if len > session.len() {
            return; // Preserve pending occupancy for a corrupt owner.
        }
        session[..len].copy_from_slice(self.request.session.as_bytes());
        let token = self.token;
        let generation = self.request.generation;
        // Disarm ordinary Drop before destroying both caller backings. This
        // state does not assume any sentinel value in the token namespace.
        self.release_on_drop = false;
        drop(std::mem::take(&mut self.request.session));
        drop(std::mem::take(&mut self.request.task_id));
        let session = std::str::from_utf8(&session[..len]).expect("granted UTF-8 session");
        let _ = self.budget.retire_ordinary(token, session, generation);
        // Failed identity/nonordinary checks retain the exact ledger record.
    }

    pub(crate) fn ensure_prepare_cpu_bytes(&self, required: u64) -> Result<(), JobError> {
        if self.request.prepare_cpu_bytes < required {
            return Err(JobError::new(
                "budget_busy",
                "字体读取与解析尚未取得完整准备工作区",
            ));
        }
        Ok(())
    }

    pub(crate) fn retained_control_heap_bytes(&self) -> Option<u64> {
        u64::try_from(
            self.request
                .session
                .capacity()
                .checked_add(self.request.task_id.capacity())?,
        )
        .ok()
    }

    pub(crate) fn asset_requested_bytes(&self) -> u64 {
        self.request.asset_cpu_bytes
    }

    #[cfg(test)]
    pub(crate) fn identity_for_test(&self) -> (&str, u64, &str) {
        (
            &self.request.session,
            self.request.generation,
            &self.request.task_id,
        )
    }
    #[cfg(test)]
    pub(crate) fn release_allocations_for_test(&self) -> (u64, [(usize, usize, usize); 2]) {
        (
            self.token,
            [
                (
                    self.request.session.as_ptr() as usize,
                    self.request.session.capacity(),
                    1,
                ),
                (
                    self.request.task_id.as_ptr() as usize,
                    self.request.task_id.capacity(),
                    1,
                ),
            ],
        )
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.release_on_drop {
            self.release();
        }
    }
}

fn empty_request(session: String) -> BudgetRequest {
    BudgetRequest {
        owner: OwnerKind::Probe,
        session,
        generation: 1,
        task_id: "decode".into(),
        targets: 0,
        contexts: 0,
        decoders: 0,
        transcode_slots: 0,
        decode_pixel_rate: 0,
        output_pixel_rate: 0,
        texture_upload_bytes_per_second: 0,
        cpu_bytes: 0,
        prepare_cpu_bytes: 0,
        asset_cpu_bytes: 0,
        gpu_bytes: 0,
        prepare_tasks: 0,
    }
}

/// 导入探测和目标规划共用媒体成本真值；呈现 owner/目标开销由规划器补齐。
pub(crate) fn decode_request(
    metadata: &MediaProbe,
    session: String,
) -> Result<BudgetRequest, JobError> {
    let mut request = empty_request(session);
    let pixels = u64::from(metadata.encoded_width) * u64::from(metadata.encoded_height);
    if pixels == 0 {
        return Err(JobError::new("format_unsupported", "解码尺寸为零"));
    }
    if metadata.container == Container::Image {
        // 解码与读回峰值按两份 RGBA 计；标准化派生另由准备工作包负责。
        request.cpu_bytes = pixels.saturating_mul(8);
        request.gpu_bytes = pixels.saturating_mul(4);
    } else {
        if metadata.encoded_width > 1920 || metadata.encoded_height > 1920 || pixels > 1920 * 1088 {
            return Err(JobError::new(
                "format_unsupported",
                "P1 视频编码尺寸超过 1920×1088 像素预算",
            ));
        }
        let fps = metadata
            .fps_upper_bound
            .or(metadata.source_fps)
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .ok_or_else(|| JobError::new("format_unsupported", "视频缺少可信帧率上界"))?;
        request.decoders = 1;
        request.decode_pixel_rate = (pixels as f64 * fps).ceil() as u64;
        // 保守缓冲估算，不宣称是实测显存或约束驱动内部缓存。
        request.cpu_bytes = pixels.saturating_mul(4 * 3);
        request.gpu_bytes = pixels.saturating_mul(4 * 6);
    }
    Ok(request)
}

#[derive(Clone)]
pub(crate) struct ProbeClient {
    backend: Backend,
    budget: Arc<BudgetCoordinator>,
    counts: Arc<ProbeCounts>,
    #[cfg(test)]
    environment_provider: Option<EnvironmentProvider>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    suppress_frames: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    force_probe: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    block_close: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_font_ready: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_font_read_ms: Option<u32>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_media_ready: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_media_read_ms: Option<u32>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    svg_render: Option<Arc<harness::SvgRenderProbe>>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    read_observation: Arc<std::sync::Mutex<Option<Arc<ReadGate>>>>,
}

#[derive(Default)]
struct ProbeCounts {
    hits: AtomicU64,
    runs: AtomicU64,
}
#[cfg(test)]
type EnvironmentProvider =
    Arc<dyn Fn() -> Option<super::probe_environment::Environment> + Send + Sync>;

#[derive(Clone)]
enum Backend {
    Native(EventLoopProxy<UserEvent>),
    #[cfg(test)]
    Test(Arc<dyn Fn(ProbeInput, Arc<AtomicBool>) -> ProbeFuture + Send + Sync>),
}

#[derive(Clone)]
pub(crate) enum ProbeInput {
    Media(DecodeInput),
    Font(FontInput),
}

impl ProbeInput {
    fn is_font(&self) -> bool {
        matches!(self, Self::Font(_))
    }
    fn pinned(&self) -> (&str, &Arc<super::assets::PinnedMedia>) {
        match self {
            Self::Media(input) => (&input.package_hash, &input.media),
            Self::Font(input) => (&input.package_hash, &input.media),
        }
    }
    fn budget_request(&self, session: String) -> Result<BudgetRequest, JobError> {
        match self {
            Self::Media(input) => decode_request(&input.metadata, session),
            Self::Font(input) => {
                let mut request = empty_request(session);
                request.cpu_bytes = input
                    .metadata
                    .cpu_budget_bytes
                    .checked_add(256 * 128 * 8)
                    .ok_or_else(|| JobError::new("format_unsupported", "字体探测成本溢出"))?;
                request.gpu_bytes = 256 * 128 * 4;
                Ok(request)
            }
        }
    }
    fn config(&self, poster: bool) -> serde_json::Value {
        let (package, pinned) = self.pinned();
        let url = super::webresource::files_url(package, &pinned.entry.path);
        match self {
            Self::Media(input) => serde_json::json!({"url":url,
                "kind": if input.metadata.container == Container::Image { "image" } else { "video" },
                "mime":pinned.entry.mime,"metadata":input.metadata,"poster":poster}),
            Self::Font(input) => serde_json::json!({"url":url,"kind":"font",
                "mime":pinned.entry.mime,"metadata":input.metadata,"poster":false}),
        }
    }
}

#[cfg(test)]
type ProbeFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), JobError>> + Send>>;

pub(super) struct ProbeOutput {
    pub browser: Option<String>,
    pub poster: Option<String>,
}

/// Only a bounded, typed settled report permits closing a font controller.
/// Success additionally requires actual glyph pixels from the loaded Face.
fn settled_font_report(body: &str) -> Option<Result<(), JobError>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Report {
        kind: String,
        ok: bool,
        code: String,
        settled: bool,
        font_status: String,
        alpha_pixels: u32,
        width: u32,
        height: u32,
    }
    if body.len() > REPORT_LIMIT {
        return None;
    }
    let report = serde_json::from_str::<Report>(body).ok()?;
    if report.kind != "font" || !report.settled {
        return None;
    }
    Some(
        if report.ok
            && report.font_status == "loaded"
            && report.width == 256
            && report.height == 128
            && report.alpha_pixels > 0
            && report.alpha_pixels <= 256 * 128
        {
            Ok(())
        } else {
            let code = match report.code.as_str() {
                "font_format_not_prepared" => "font_format_not_prepared",
                "font_decode_failed" => "font_decode_failed",
                _ => "probe_inconclusive",
            };
            Err(JobError::new(code, "同包字体加载与真实字形绘制未通过"))
        },
    )
}

impl ProbeClient {
    pub(crate) fn native(proxy: EventLoopProxy<UserEvent>) -> Self {
        Self {
            backend: Backend::Native(proxy),
            budget: global_budget(),
            counts: Arc::default(),
            #[cfg(test)]
            environment_provider: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            suppress_frames: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            force_probe: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            block_close: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_font_ready: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_font_read_ms: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_media_ready: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_media_read_ms: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            svg_render: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            read_observation: Arc::default(),
        }
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn suppress_frames_for_test(mut self, suppress: bool) -> Self {
        self.suppress_frames = suppress;
        self
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn force_probe_for_test(mut self, force: bool) -> Self {
        self.force_probe = force;
        self
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn block_close_for_test(mut self, blocked: bool) -> Self {
        self.block_close = blocked;
        self
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn hold_font_ready_for_test(mut self, held: bool) -> Self {
        self.hold_font_ready = held;
        self
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn hold_font_read_for_test(mut self, milliseconds: Option<u32>) -> Self {
        self.hold_font_read_ms = milliseconds;
        self
    }
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn hold_media_read_for_test(
        mut self,
        ready: bool,
        milliseconds: Option<u32>,
    ) -> Self {
        self.hold_media_ready = ready;
        self.hold_media_read_ms = milliseconds;
        self
    }
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn svg_render_for_test(
        mut self,
        observation: Option<Arc<harness::SvgRenderProbe>>,
    ) -> Self {
        self.svg_render = observation;
        self
    }
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn svg_event_for_test(&self, phase: &'static str, source: Option<&str>) {
        if let Some(svg) = &self.svg_render {
            svg.event(phase, source);
        }
    }
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn svg_barrier_for_test(&self, boundary: harness::SvgBarrier) {
        if let Some(svg) = &self.svg_render {
            svg.barrier(boundary);
        }
    }
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    pub(crate) fn held_read_snapshot_for_test(&self) -> Option<ReadProbeSnapshot> {
        let gate = self
            .read_observation
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        gate.map(|gate| gate.snapshot())
    }

    pub(crate) fn stats(&self) -> (u64, u64) {
        (
            self.counts.hits.load(Ordering::Relaxed),
            self.counts.runs.load(Ordering::Relaxed),
        )
    }
    pub(super) fn note_cache_hit(&self) {
        self.counts.hits.fetch_add(1, Ordering::Relaxed);
    }
    pub(super) fn cache_allowed(&self) -> bool {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.force_probe || self.suppress_frames || self.hold_font_ready {
            return false;
        }
        true
    }
    pub(super) fn check_metadata(&self, metadata: &MediaProbe) -> Result<(), JobError> {
        decode_request(metadata, "qualification".into()).map(|_| ())
    }
    pub(super) async fn environment(&self) -> Option<super::probe_environment::Environment> {
        match &self.backend {
            Backend::Native(proxy) => {
                let (reply, receive) = oneshot::channel();
                proxy
                    .send_event(UserEvent::WallpaperProbeEnvironment(reply))
                    .ok()?;
                let browser = tokio::time::timeout(Duration::from_secs(2), receive)
                    .await
                    .ok()?
                    .ok()??;
                super::probe_environment::capture(browser)
            }
            #[cfg(test)]
            Backend::Test(_) => self
                .environment_provider
                .as_ref()
                .and_then(|provider| provider()),
        }
    }
    #[cfg(test)]
    pub(crate) fn environment_for_test(
        mut self,
        provider: impl Fn() -> Option<super::probe_environment::Environment> + Send + Sync + 'static,
    ) -> Self {
        self.environment_provider = Some(Arc::new(provider));
        self
    }

    #[cfg(test)]
    pub(crate) fn testing(
        probe: impl Fn(DecodeInput, Arc<AtomicBool>) -> ProbeFuture + Send + Sync + 'static,
    ) -> Self {
        Self::testing_input(move |input, cancel| match input {
            ProbeInput::Media(input) => probe(input, cancel),
            ProbeInput::Font(_) => Box::pin(async {
                Err(JobError::new(
                    "probe_inconclusive",
                    "媒体测试适配器未提供字体资格",
                ))
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn testing_input(
        probe: impl Fn(ProbeInput, Arc<AtomicBool>) -> ProbeFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            backend: Backend::Test(Arc::new(probe)),
            budget: Arc::new(BudgetCoordinator::new()),
            counts: Arc::default(),
            environment_provider: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            suppress_frames: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            force_probe: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            block_close: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_font_ready: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_font_read_ms: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_media_ready: false,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            hold_media_read_ms: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            svg_render: None,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            read_observation: Arc::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn budget_for_test(&self) -> Arc<BudgetCoordinator> {
        Arc::clone(&self.budget)
    }

    pub(crate) fn prepare(&self, session: String) -> Result<Reservation, JobError> {
        Reservation::prepare(Arc::clone(&self.budget), session)
    }

    /// Model source work inherits the actual original job generation.
    pub(crate) fn prepare_for_job(
        &self,
        session: String,
        generation: u64,
    ) -> Result<Reservation, JobError> {
        let mut request = empty_request(session);
        request.generation = generation;
        request.task_id = "prepare".into();
        request.prepare_tasks = 1;
        Reservation::grant(Arc::clone(&self.budget), request)
    }

    /// Memory-only child of a borrowed original preparation. No new worker,
    /// renderer, decoder, generation registry or advisory ledger projection.
    pub(crate) fn job_memory(
        &self,
        preparation: &Reservation,
        task: &'static str,
        workspace: u64,
        retained: u64,
    ) -> Result<Reservation, JobError> {
        if !Arc::ptr_eq(&self.budget, &preparation.budget)
            || preparation.request.owner != OwnerKind::Probe
            || preparation.request.prepare_tasks != 1
            || preparation.request.task_id != "prepare"
            || !matches!(
                task,
                "model-source-opening"
                    | "model-identity"
                    | "model-source"
                    | "model-inspection"
                    | "model-input"
            )
        {
            return Err(JobError::invalid_input(
                "model memory requires its original job preparation",
            ));
        }
        let mut request = empty_request(preparation.request.session.clone());
        request.generation = preparation.request.generation;
        request.task_id = task.into();
        request.prepare_cpu_bytes = workspace;
        request.asset_cpu_bytes = retained;
        Reservation::grant(Arc::clone(&self.budget), request)
    }

    /// Advisory memory projection on this probe's original ledger. No grant,
    /// token or revision is published, including for release-pending owners.
    pub(crate) fn check_requests(&self, requests: &[BudgetRequest]) -> Result<(), JobError> {
        self.budget.check_requests(requests).map_err(|error| {
            JobError::new("budget_busy", format!("{}: {}", error.quota, error.message))
                .with_details(serde_json::json!({
                    "quota": error.quota, "cap": error.cap,
                    "held": error.held, "requested": error.requested
                }))
        })
    }

    pub(crate) fn image_workspace(&self, bytes: u64) -> Result<Reservation, JobError> {
        let mut request = empty_request(format!(
            "image-{}",
            NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
        ));
        request.prepare_cpu_bytes = bytes;
        Reservation::grant(Arc::clone(&self.budget), request)
    }

    pub(super) async fn run(
        &self,
        input: DecodeInput,
        cancel: Arc<AtomicBool>,
        poster: bool,
    ) -> Result<ProbeOutput, JobError> {
        self.run_input(ProbeInput::Media(input), cancel, poster)
            .await
    }

    pub(super) async fn run_font(
        &self,
        input: FontInput,
        cancel: Arc<AtomicBool>,
    ) -> Result<ProbeOutput, JobError> {
        self.run_input(ProbeInput::Font(input), cancel, false).await
    }

    async fn run_input(
        &self,
        input: ProbeInput,
        cancel: Arc<AtomicBool>,
        poster: bool,
    ) -> Result<ProbeOutput, JobError> {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.hold_media_read_ms.is_some_and(|milliseconds| {
            input.is_font()
                || !self.force_probe
                || !self.hold_media_ready
                || !self.block_close
                || !(500..=harness::MAX_SVG_BARRIER_MS).contains(&milliseconds)
        }) {
            return Err(JobError::invalid_input(
                "held media Read requires bounded forceProbe/holdMediaReady/blockClose",
            ));
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if let Some(milliseconds) = self.hold_font_read_ms {
            if !input.is_font()
                || !self.force_probe
                || !self.hold_font_ready
                || !self.block_close
                || !(super::istream::read_probe::MIN_HOLD_MS
                    ..=super::istream::read_probe::MAX_HOLD_MS)
                    .contains(&milliseconds)
            {
                return Err(JobError::invalid_input(
                    "held font Read requires bounded forceProbe/holdFontReady/blockClose",
                ));
            }
        }
        if cancel.load(Ordering::Acquire) {
            return Err(JobError::new("cancelled", "解码探测已取消"));
        }
        self.counts.runs.fetch_add(1, Ordering::Relaxed);
        if let ProbeInput::Media(input) = &input {
            if input.metadata.codec == "png" {
                let mut request = decode_request(
                    &input.metadata,
                    format!("png-{}", NEXT_PROBE.fetch_add(1, Ordering::Relaxed)),
                )?;
                request.gpu_bytes = 0;
                let reservation = Reservation::grant(Arc::clone(&self.budget), request)?;
                let validation = validate_png(input, &cancel);
                reservation.finish();
                validation?;
            }
        }
        match &self.backend {
            Backend::Native(proxy) => {
                let (reply, receive) = oneshot::channel();
                let request = ProbeRequest {
                    id: NEXT_PROBE.fetch_add(1, Ordering::Relaxed),
                    input,
                    cancel,
                    reply,
                    deadline: Instant::now() + PROBE_LIMIT,
                    poster,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    suppress_frames: self.suppress_frames,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    block_close: self.block_close,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    hold_font_ready: self.hold_font_ready,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    force_probe: self.force_probe,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    hold_font_read_ms: self.hold_font_read_ms,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    hold_media_ready: self.hold_media_ready,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    hold_media_read_ms: self.hold_media_read_ms,
                    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                    read_observation: Arc::clone(&self.read_observation),
                };
                proxy
                    .send_event(UserEvent::WallpaperProbe(Box::new(request)))
                    .map_err(|_| JobError::new("probe_inconclusive", "解码宿主已退出"))?;
                // 不用 select!/timeout 提前丢下解码器：宿主完成物理清理后才回执。
                receive
                    .await
                    .map_err(|_| JobError::new("probe_inconclusive", "解码宿主未完成回收回执"))?
            }
            #[cfg(test)]
            Backend::Test(probe) => {
                let frame = match &input {
                    ProbeInput::Media(media) if poster => {
                        super::video_poster::test_frame(&media.metadata)
                    }
                    _ => None,
                };
                probe(input, cancel).await.map(|_| ProbeOutput {
                    browser: Some("test-webview2".into()),
                    poster: frame,
                })
            }
        }
    }
}

fn validate_png(input: &DecodeInput, cancel: &AtomicBool) -> Result<(), JobError> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&input.media.path)
        .map_err(|error| JobError::io(error.to_string()))?;
    let decoder = png::Decoder::new_with_limits(
        std::io::BufReader::new(file),
        png::Limits {
            bytes: 128 * 1024 * 1024,
        },
    );
    let invalid = |error: png::DecodingError| {
        JobError::new("decode_failed", format!("PNG 像素/CRC 校验失败：{error}"))
    };
    let mut reader = decoder.read_info().map_err(invalid)?;
    let deadline = Instant::now() + PROBE_LIMIT;
    while reader.next_row().map_err(invalid)?.is_some() {
        if cancel.load(Ordering::Acquire) {
            return Err(JobError::new("cancelled", "PNG 解码已取消"));
        }
        if Instant::now() >= deadline {
            return Err(JobError::new("probe_inconclusive", "PNG 解码超过 15 秒"));
        }
    }
    reader.finish().map_err(invalid)
}

pub(crate) struct ProbeRequest {
    id: u64,
    input: ProbeInput,
    cancel: Arc<AtomicBool>,
    reply: oneshot::Sender<Result<ProbeOutput, JobError>>,
    deadline: Instant,
    poster: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    suppress_frames: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    block_close: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_font_ready: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    force_probe: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_font_read_ms: Option<u32>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_media_ready: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    hold_media_read_ms: Option<u32>,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    read_observation: Arc<std::sync::Mutex<Option<Arc<ReadGate>>>>,
}

struct Surface {
    // WebView 先于窗口销毁。
    webview: WebView,
    _web_context: WebContext,
    window: Window,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    close_probe_blocked: bool,
}

impl Surface {
    fn close_controller(&self) -> Result<(), i32> {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.close_probe_blocked {
            return Err(0x80004005_u32 as i32);
        }
        unsafe { self.webview.controller().Close() }.map_err(|error| error.code().0)
    }
}

struct HostedProbe {
    // Drops before Surface without giving HostedProbe a Drop impl (tick moves output).
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    read_drop: HostDropGuard,
    id: u64,
    cancel: Arc<AtomicBool>,
    reply: Option<oneshot::Sender<Result<ProbeOutput, JobError>>>,
    browser: Option<String>,
    poster: Option<String>,
    deadline: Instant,
    config: serde_json::Value,
    started: bool,
    font_settled: bool,
    surface: Option<Surface>,
    access: MediaAccess,
    drain: Option<Drain>,
    reservation: Option<Reservation>,
    outcome: Option<Result<(), JobError>>,
    close_attempts: u64,
    close_error: Option<i32>,
    close_failed_since: Option<Instant>,
    last_close_ms: u64,
}

#[derive(Default)]
pub(crate) struct ProbeHost {
    current: Option<HostedProbe>,
}

impl ProbeHost {
    pub(crate) fn start(
        &mut self,
        request: ProbeRequest,
        target: &EventLoopWindowTarget<()>,
        proxy: EventLoopProxy<UserEvent>,
    ) {
        if self.current.is_some() {
            let _ = request.reply.send(Err(JobError::new(
                "budget_busy",
                "已有解码容器正在运行或回收",
            )));
            return;
        }
        if request.cancel.load(Ordering::Acquire) {
            let _ = request
                .reply
                .send(Err(JobError::new("cancelled", "解码探测已取消")));
            return;
        }
        if Instant::now() >= request.deadline {
            let _ = request.reply.send(Err(JobError::new(
                "probe_inconclusive",
                "解码探测未能及时启动",
            )));
            return;
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if request.hold_media_read_ms.is_some_and(|milliseconds| {
            request.input.is_font()
                || !request.force_probe
                || !request.hold_media_ready
                || !request.block_close
                || !(500..=harness::MAX_SVG_BARRIER_MS).contains(&milliseconds)
        }) {
            let _ = request.reply.send(Err(JobError::invalid_input(
                "invalid held media Read configuration",
            )));
            return;
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if request.hold_font_read_ms.is_some_and(|milliseconds| {
            !request.input.is_font()
                || !request.force_probe
                || !request.hold_font_ready
                || !request.block_close
                || !(super::istream::read_probe::MIN_HOLD_MS
                    ..=super::istream::read_probe::MAX_HOLD_MS)
                    .contains(&milliseconds)
        }) {
            let _ = request.reply.send(Err(JobError::invalid_input(
                "invalid held font Read configuration",
            )));
            return;
        }
        let result = request
            .input
            .budget_request(format!("probe-{}", request.id))
            .and_then(|mut budget| {
                if request.poster {
                    budget.cpu_bytes += 2 * 1024 * 1024;
                    budget.gpu_bytes += 320 * 320 * 4;
                }
                Reservation::grant(global_budget(), budget)
            });
        let reservation = match result {
            Ok(reservation) => reservation,
            Err(error) => {
                let _ = request.reply.send(Err(error));
                return;
            }
        };
        let suppress_frames = {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            {
                request.suppress_frames
            }
            #[cfg(not(all(feature = "wallpaper-media-probe", debug_assertions)))]
            {
                false
            }
        };
        let surface = create_surface(
            target,
            proxy,
            request.id,
            suppress_frames,
            request.input.is_font(),
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            request.hold_font_ready,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            request.hold_media_ready,
        );
        let (surface, access) = match surface {
            Ok(surface) => surface,
            Err(error) => {
                reservation.finish();
                let _ = request.reply.send(Err(error));
                return;
            }
        };
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        let surface = Surface {
            close_probe_blocked: request.block_close,
            ..surface
        };
        let config = request.input.config(request.poster);
        let (package_hash, pinned) = request.input.pinned();
        let granted = access.grant_pinned(request.id, package_hash.into(), Arc::clone(pinned));
        let admission_failed = !granted || config["url"].is_null();
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        let (read_gate, admission_failed) =
            if let Some(milliseconds) = request.hold_font_read_ms.or(request.hold_media_read_ms) {
                let gate = ReadGate::new(
                    ReadOwner {
                        probe_id: request.id,
                        generation: request.id,
                        session: format!("probe-{}", request.id),
                        package_hash: package_hash.into(),
                        entry_path: pinned.entry.path.clone(),
                        content_sha256: pinned.entry.sha256.clone(),
                        content_bytes: pinned.entry.bytes,
                    },
                    milliseconds,
                    std::thread::current().id(),
                );
                let armed = granted
                    && gate.as_ref().is_some_and(|gate| {
                        access.arm_file_read_probe_for_test(
                            request.id,
                            package_hash,
                            &pinned.entry.path,
                            Arc::clone(gate),
                        )
                    });
                if let Some(gate) = &gate {
                    if !armed {
                        gate.release(ReleaseReason::InternalFailure);
                    }
                }
                *request
                    .read_observation
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = gate.clone();
                (gate, admission_failed || !armed)
            } else {
                (None, admission_failed)
            };
        let browser = super::probe_environment::browser_version(&surface.webview);
        self.current = Some(HostedProbe {
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            read_drop: HostDropGuard(read_gate),
            id: request.id,
            cancel: request.cancel,
            reply: Some(request.reply),
            browser,
            poster: None,
            deadline: request.deadline,
            config,
            started: false,
            font_settled: true,
            surface: Some(surface),
            access,
            drain: None,
            reservation: Some(reservation),
            outcome: admission_failed
                .then(|| Err(JobError::new("probe_inconclusive", "探测准入失败"))),
            close_attempts: 0,
            close_error: None,
            close_failed_since: None,
            last_close_ms: 0,
        });
        self.tick();
    }

    pub(crate) fn page(&mut self, id: u64, body: &str) {
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.handle_read_probe(id, body) {
            return;
        }
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        if self.handle_close_probe(id, body) {
            return;
        }
        // Resolve the original cancellation/deadline before accepting a report.
        // An unsettled font keeps its controller and reservation through tick.
        self.tick();
        // FontFace.load cannot be cancelled. Its settled receipt remains usable
        // after cancellation/deadline to allow the original close/drain owner
        // to reclaim the reservation, without upgrading an earlier failure.
        if body != "ready" {
            if let Some(probe) = self
                .current
                .as_mut()
                .filter(|probe| probe.id == id && probe.started && probe.config["kind"] == "font")
            {
                if let Some(outcome) = settled_font_report(body) {
                    probe.font_settled = true;
                    if probe.outcome.is_none() {
                        probe.outcome = Some(outcome);
                    }
                }
                self.tick();
                return;
            }
        }
        let Some(probe) = self
            .current
            .as_mut()
            .filter(|probe| probe.id == id && probe.outcome.is_none())
        else {
            return;
        };
        if body == "ready" && !probe.started {
            probe.started = true;
            probe.font_settled = probe.config["kind"] != "font";
            if probe.surface.as_ref().is_none_or(|surface| {
                surface
                    .webview
                    .evaluate_script(&format!("window.hertzDecodeProbe.run({});", probe.config))
                    .is_err()
            }) {
                probe.font_settled = true;
                probe.outcome = Some(Err(JobError::new("probe_inconclusive", "探测脚本未能启动")));
            }
        } else if probe.started && body.len() <= REPORT_LIMIT {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Report {
                ok: bool,
                code: String,
                stage: String,
                frames: Vec<f64>,
                width: u32,
                height: u32,
                #[serde(default)]
                poster: Option<String>,
            }
            if let Ok(report) = serde_json::from_str::<Report>(body) {
                crate::app::log(&format!(
                    "decode probe report id={id} ok={} stage={} frames={:?} size={}x{}",
                    report.ok, report.stage, report.frames, report.width, report.height
                ));
                let image = probe.config["kind"] == "image";
                let valid_frames = if image {
                    report.frames.is_empty()
                } else {
                    report.frames.len() == 3
                        && report
                            .frames
                            .iter()
                            .all(|time| time.is_finite() && *time >= 0.0)
                        && report.frames.windows(2).all(|pair| pair[1] > pair[0])
                };
                if report.ok && valid_frames && probe.config["poster"] == true && !image {
                    probe.poster = report
                        .poster
                        .filter(|image| image.len() <= super::video_poster::ENCODED_LIMIT);
                }
                probe.outcome = Some(
                    if report.ok && valid_frames && report.width > 0 && report.height > 0 {
                        Ok(())
                    } else {
                        let code = match report.code.as_str() {
                            "format_unsupported" => "format_unsupported",
                            "decode_failed" => "decode_failed",
                            _ => "probe_inconclusive",
                        };
                        Err(JobError::new(code, "真实媒体解码/seek 未通过"))
                    },
                );
            }
        }
        self.tick();
    }

    pub(crate) fn close_window(&mut self, id: WindowId) -> bool {
        let Some(probe) = self
            .current
            .as_mut()
            .filter(|probe| probe.surface.as_ref().is_some_and(|s| s.window.id() == id))
        else {
            return false;
        };
        probe.cancel.store(true, Ordering::Release);
        self.tick();
        true
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.current
            .as_ref()
            .map(|_| Instant::now() + Duration::from_millis(25))
    }

    pub(crate) fn diagnostics(&self) -> serde_json::Value {
        self.current.as_ref().map_or(serde_json::Value::Null, |probe| {
            let value = serde_json::json!({
                "probeId": probe.id,
                "started": probe.started,
                "fontSettled": probe.font_settled,
                "outcome": probe.outcome.as_ref().map(|outcome| match outcome {
                    Ok(()) => "ok",
                    Err(error) => error.code,
                }),
                "controllerClosed": probe.surface.is_none(),
                "fileReadersDrained": probe.drain.as_ref().is_some_and(Drain::is_drained),
                "closeAttempts": probe.close_attempts,
                "closeError": probe.close_error.map(|error| format!("0x{:08X}", error as u32)),
                "closeFailedAgeMs": probe.close_failed_since.map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
                "lastCloseMs": probe.last_close_ms,
            });
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            let value = {
                let mut value = value;
                if let Some(gate) = &probe.read_drop.0 {
                    value["heldIstreamRead"] = serde_json::to_value(gate.snapshot()).unwrap_or(serde_json::Value::Null);
                    if let Some((active, readers)) = probe.access.debug_scope_snapshot(gate.owner.generation) {
                        value["scopeActive"] = serde_json::json!(active);
                        value["scopeReaders"] = serde_json::json!(readers);
                    }
                }
                value
            };
            value
        })
    }

    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    fn handle_read_probe(&mut self, source_id: u64, body: &str) -> bool {
        let Some(body) = body.strip_prefix(super::istream::read_probe::PREFIX) else {
            return false;
        };
        let Some(probe) = self.current.as_ref().filter(|probe| probe.id == source_id) else {
            return true;
        };
        let Some(surface) = &probe.surface else {
            return true;
        };
        let request = ReadControl::parse(body);
        let nonce = request.as_ref().map(ReadControl::nonce).or_else(|| {
            if body.len() > 512 {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(body)
                .ok()?
                .get("nonce")?
                .as_u64()
                .filter(|nonce| *nonce > 0 && *nonce <= 9_007_199_254_740_991)
        });
        let accepted = request.as_ref().is_some_and(|request| {
            probe
                .read_drop
                .0
                .as_ref()
                .is_some_and(|gate| gate.handle(request, source_id, probe.id))
        });
        let snapshot = probe.read_drop.0.as_ref().map(|gate| gate.snapshot());
        let _ = surface.webview.evaluate_script(&format!(
            "window.__nativeDecodeReadProbe={};",
            serde_json::json!({"nonce":nonce,"accepted":accepted,"snapshot":snapshot})
        ));
        true
    }

    pub(crate) fn tick(&mut self) {
        let Some(probe) = self.current.as_mut() else {
            return;
        };
        if probe.cancel.load(Ordering::Acquire) {
            probe.outcome = Some(Err(JobError::new("cancelled", "解码探测已取消")));
        } else if probe.outcome.is_none() && Instant::now() >= probe.deadline {
            probe.outcome = Some(Err(JobError::new(
                "probe_inconclusive",
                "15 秒内未获得完整解码/seek 证据",
            )));
        }
        if probe.outcome.is_none() {
            return;
        }
        if probe.drain.is_none() {
            if let Some(surface) = probe.surface.as_ref() {
                let _ = surface
                    .webview
                    .evaluate_script("window.hertzDecodeProbe.stop();");
            }
            probe.drain = Some(probe.access.revoke());
            if let Some(reservation) = probe.reservation.as_ref() {
                reservation.release();
            }
        }
        if !probe.font_settled {
            return;
        }
        if let Some(surface) = probe.surface.as_ref() {
            // 单个媒体元素的 emptied 不足以证明 decoder 退出，关闭独立 controller。
            probe.close_attempts = probe.close_attempts.saturating_add(1);
            let started = Instant::now();
            let result = surface.close_controller();
            probe.last_close_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if let Err(error) = result {
                if probe.close_error != Some(error) {
                    crate::app::log(&format!(
                        "probe controller close pending id={} HRESULT=0x{:08X}",
                        probe.id, error as u32
                    ));
                }
                probe.close_error = Some(error);
                probe.close_failed_since.get_or_insert_with(Instant::now);
                return;
            }
            probe.close_error = None;
            probe.close_failed_since = None;
            probe.surface.take();
        }
        if !probe.drain.as_ref().is_some_and(Drain::is_drained) {
            return;
        }
        let mut probe = self.current.take().expect("current probe");
        if let Some(reservation) = probe.reservation.take() {
            reservation.finish();
        }
        let outcome = probe.outcome.take().expect("probe outcome");
        crate::app::log(&format!(
            "decode probe id={} reclaimed result={}",
            probe.id,
            if outcome.is_ok() { "ok" } else { "failed" }
        ));
        if let Some(reply) = probe.reply.take() {
            let _ = reply.send(outcome.map(|_| ProbeOutput {
                browser: probe.browser,
                poster: probe.poster,
            }));
        }
    }
}

fn create_surface(
    target: &EventLoopWindowTarget<()>,
    proxy: EventLoopProxy<UserEvent>,
    id: u64,
    suppress_frames: bool,
    font: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))] hold_font_ready: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))] hold_media_ready: bool,
) -> Result<(Surface, MediaAccess), JobError> {
    let window = WindowBuilder::new()
        .with_title(if font {
            "Hertz · 字体兼容性检查"
        } else {
            "Hertz · 媒体兼容性检查"
        })
        .with_inner_size(LogicalSize::new(400.0, 250.0))
        .with_resizable(false)
        .with_visible(true)
        .with_focused(false)
        .build(target)
        .map_err(|error| JobError::new("probe_inconclusive", error.to_string()))?;
    let script = if font {
        include_str!("../../assets/wallpaper-font-probe.js").to_string()
    } else if suppress_frames {
        format!(
            "HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;\n{}",
            include_str!("../../assets/wallpaper-probe.js")
        )
    } else {
        include_str!("../../assets/wallpaper-probe.js").to_string()
    };
    // Debug acceptance arms CDP on this exact controller before its original
    // ready handshake starts FontFace. The production script is unchanged.
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    let script = if font && hold_font_ready {
        script.replace(
            "window.ipc.postMessage('ready');",
            "window.__hertzFontProbeReadyHeld = true;",
        )
    } else if !font && hold_media_ready {
        script.replace(
            "post('ready');",
            "window.__hertzMediaProbeReadyHeld = true;",
        )
    } else {
        script
    };
    let mut page =
        include_str!("../../assets/wallpaper-probe.html").replace("/* PROBE_SCRIPT */", &script);
    if font {
        page = page
            .replace("媒体兼容性检查", "字体兼容性检查")
            .replace("正在检查媒体兼容性…", "正在检查字体加载与字形绘制…");
    }
    let csp = if font {
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src https://*.wallpaper.invalid; connect-src 'none'; frame-src 'none'; base-uri 'none'"
    } else {
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://*.wallpaper.invalid; media-src https://*.wallpaper.invalid; connect-src 'none'; frame-src 'none'; base-uri 'none'"
    };
    let page_proxy = proxy.clone();
    let mut web_context = WebContext::new(Some(crate::config::webview_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_custom_protocol("hertz".into(), move |_, request| {
            let here = request.uri().path() == "/wallpaper-probe.html";
            wry::http::Response::builder()
                .status(if here { 200 } else { 404 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", csp)
                .body(std::borrow::Cow::Owned(if here {
                    page.as_bytes().to_vec()
                } else {
                    Vec::new()
                }))
                .expect("probe response")
        })
        .with_navigation_handler(|url| {
            url == "http://hertz.localhost/wallpaper-probe.html"
                || url == "hertz://localhost/wallpaper-probe.html"
        })
        .with_url("hertz://localhost/wallpaper-probe.html")
        .with_ipc_handler(move |request| {
            if request.body().len() <= REPORT_LIMIT {
                let _ = page_proxy
                    .send_event(UserEvent::WallpaperProbePage(id, request.body().clone()));
            }
        })
        .build(&window)
        .map_err(|error| JobError::new("probe_inconclusive", error.to_string()))?;
    let access = super::webresource::install(&webview, proxy)
        .map_err(|error| JobError::new("probe_inconclusive", error))?;
    Ok((
        Surface {
            webview,
            _web_context: web_context,
            window,
            #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
            close_probe_blocked: false,
        },
        access,
    ))
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[path = "decode_probe_close.rs"]
mod close_probe;

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[path = "decode_probe_harness.rs"]
pub(crate) mod harness;

#[cfg(test)]
#[path = "decode_probe_tests.rs"]
mod tests;
