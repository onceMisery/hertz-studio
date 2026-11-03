// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! §7.1 第二道准入：受信、可独立关闭的可见 WebView2 解码容器。
//! worker 只发送已固定字节；UI 不打开文件。回执在 controller Close 成功、
//! Broker 撤销且所有真实文件活动退出后发送，取消/期限都不提前释放配额。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event_loop::{EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Window, WindowBuilder, WindowId};
use tokio::sync::oneshot;
use wry::{WebView, WebViewBuilder, WebViewExtWindows};

use super::access::{Drain, MediaAccess};
use super::assets::DecodeInput;
use super::budget::global as global_budget;
use super::budget::{BudgetCoordinator, BudgetRequest, OwnerKind};
use super::jobs::JobError;
use super::media::{Container, MediaProbe};
use crate::app::UserEvent;

const PROBE_LIMIT: Duration = Duration::from_secs(15);
const REPORT_LIMIT: usize = 40 * 1024;
static NEXT_PROBE: AtomicU64 = AtomicU64::new(1);

/// Drop 仅标记 release，不能证明物理退出。调用方必须在清理屏障后 finish。
pub(crate) struct Reservation {
    budget: Arc<BudgetCoordinator>,
    request: BudgetRequest,
    token: u64,
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

    pub(crate) fn finish(self) {
        self.release();
        let _ =
            self.budget
                .confirm_exit(self.token, &self.request.session, self.request.generation);
        // 每笔探测/准备使用独立 session，退出后无需永久保留墓碑。
        self.budget.purge_session(&self.request.session, self.request.generation);
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.release();
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
        cpu_bytes: 0,
        prepare_cpu_bytes: 0,
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
    Test(Arc<dyn Fn(DecodeInput, Arc<AtomicBool>) -> ProbeFuture + Send + Sync>),
}

#[cfg(test)]
type ProbeFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), JobError>> + Send>>;

pub(super) struct ProbeOutput {
    pub browser: Option<String>,
    pub poster: Option<String>,
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
        if self.force_probe || self.suppress_frames || self.block_close {
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
        }
    }

    pub(crate) fn prepare(&self, session: String) -> Result<Reservation, JobError> {
        Reservation::prepare(Arc::clone(&self.budget), session)
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
        if cancel.load(Ordering::Acquire) {
            return Err(JobError::new("cancelled", "解码探测已取消"));
        }
        self.counts.runs.fetch_add(1, Ordering::Relaxed);
        if input.metadata.codec == "png" {
            let mut request = decode_request(
                &input.metadata,
                format!("png-{}", NEXT_PROBE.fetch_add(1, Ordering::Relaxed)),
            )?;
            request.gpu_bytes = 0;
            let reservation = Reservation::grant(Arc::clone(&self.budget), request)?;
            let validation = validate_png(&input, &cancel);
            reservation.finish();
            validation?;
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
                let frame = if poster {
                    super::video_poster::test_frame(&input.metadata)
                } else {
                    None
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
    input: DecodeInput,
    cancel: Arc<AtomicBool>,
    reply: oneshot::Sender<Result<ProbeOutput, JobError>>,
    deadline: Instant,
    poster: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    suppress_frames: bool,
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    block_close: bool,
}

struct Surface {
    // WebView 先于窗口销毁。
    webview: WebView,
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
    id: u64,
    cancel: Arc<AtomicBool>,
    reply: Option<oneshot::Sender<Result<ProbeOutput, JobError>>>,
    browser: Option<String>,
    poster: Option<String>,
    deadline: Instant,
    config: serde_json::Value,
    started: bool,
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
        target: &EventLoopWindowTarget<UserEvent>,
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
        let result = decode_request(&request.input.metadata, format!("probe-{}", request.id))
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
        let surface = create_surface(target, proxy, request.id, suppress_frames);
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
        let url = super::webresource::files_url(
            &request.input.package_hash,
            &request.input.media.entry.path,
        );
        let config = serde_json::json!({
            "url": url,
            "kind": if request.input.metadata.container == Container::Image { "image" } else { "video" },
            "mime": request.input.media.entry.mime,
            "metadata": request.input.metadata,
            "poster": request.poster,
        });
        let granted =
            access.grant_pinned(request.id, request.input.package_hash, request.input.media);
        let browser = super::probe_environment::browser_version(&surface.webview);
        self.current = Some(HostedProbe {
            id: request.id,
            cancel: request.cancel,
            reply: Some(request.reply),
            browser,
            poster: None,
            deadline: request.deadline,
            config,
            started: false,
            surface: Some(surface),
            access,
            drain: None,
            reservation: Some(reservation),
            outcome: (!granted || url.is_none())
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
        if self.handle_close_probe(id, body) {
            return;
        }
        self.tick();
        let Some(probe) = self
            .current
            .as_mut()
            .filter(|probe| probe.id == id && probe.outcome.is_none())
        else {
            return;
        };
        if body == "ready" && !probe.started {
            probe.started = true;
            if probe.surface.as_ref().is_none_or(|surface| {
                surface
                    .webview
                    .evaluate_script(&format!("window.hertzDecodeProbe.run({});", probe.config))
                    .is_err()
            }) {
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
            serde_json::json!({
                "probeId": probe.id,
                "started": probe.started,
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
            })
        })
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
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
    id: u64,
    suppress_frames: bool,
) -> Result<(Surface, MediaAccess), JobError> {
    let window = WindowBuilder::new()
        .with_title("Hertz · 媒体兼容性检查")
        .with_inner_size(LogicalSize::new(400.0, 250.0))
        .with_resizable(false)
        .with_visible(true)
        .with_focused(false)
        .build(target)
        .map_err(|error| JobError::new("probe_inconclusive", error.to_string()))?;
    let script = if suppress_frames {
        format!(
            "HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;\n{}",
            include_str!("../../assets/wallpaper-probe.js")
        )
    } else {
        include_str!("../../assets/wallpaper-probe.js").to_string()
    };
    let page =
        include_str!("../../assets/wallpaper-probe.html").replace("/* PROBE_SCRIPT */", &script);
    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_custom_protocol("hertz".into(), move |_, request| {
            let here = request.uri().path() == "/wallpaper-probe.html";
            wry::http::Response::builder().status(if here { 200 } else { 404 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://*.wallpaper.invalid; media-src https://*.wallpaper.invalid; connect-src 'none'; frame-src 'none'; base-uri 'none'")
                .body(std::borrow::Cow::Owned(if here { page.as_bytes().to_vec() } else { Vec::new() })).expect("probe response")
        })
        .with_navigation_handler(|url| url == "http://hertz.localhost/wallpaper-probe.html" || url == "hertz://localhost/wallpaper-probe.html")
        .with_url("hertz://localhost/wallpaper-probe.html")
        .with_ipc_handler(move |request| {
            if request.body().len() <= REPORT_LIMIT {
                let _ = page_proxy.send_event(UserEvent::WallpaperProbePage(id, request.body().clone()));
            }
        }).build(&window).map_err(|error| JobError::new("probe_inconclusive", error.to_string()))?;
    let access = super::webresource::install(&webview, proxy)
        .map_err(|error| JobError::new("probe_inconclusive", error))?;
    Ok((Surface {
        webview,
        window,
        #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
        close_probe_blocked: false,
    }, access))
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
