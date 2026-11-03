// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸会话状态机（设计 docs/desktop-wallpaper.md §13.3，P1-04b）。
//!
//! `disabled → resolving → preparing → attaching → ready → running/paused`；
//! 失败进入 `failed`，目标屏缺席进入 `waitingDisplay`。状态携带
//! desiredRevision/appliedRevision/generation、带 scope 的暂停原因集合与
//! 结构化 error。
//!
//! ready 四事实（§13.3，缺一不揭幕）：资源准入成功（对接 budget 账本）、
//! 原生窗口挂载/可见确认、当前 generation 页面握手、后端 firstFrameReady
//! （图片=decode 完成，视频=首个帧回调，WebGL=当前会话真实提交）。"DOM
//! ready"与调用前计数不等价；所有事件按 generation 校验，旧代际迟到结果
//! 被忽略（§13.3 轮询受 generation 约束）。
//!
//! 暂停原因（§13.2）：每个原因独立增删并带 scope（allPresentations /
//! desktopOnly / previewOnly），解除只移除对应范围，不清空集合；原因名沿用
//! policy.rs 的常量，不建第二份名字表。桌面忽略 previewOnly，独立预览忽略
//! desktopOnly；两者复用就绪/退出状态机并分别持有预算。
//!
//! 恢复预算（§13.3）：120 秒最多 3 次，按故障域记账——单会话故障计会话
//! 预算，Explorer 全局重挂计一次全局预算（不按屏幕数消耗）；超额进入
//! 终止态，只接受用户明确重试，时间经过不自动解锁。
//!
//! 单媒体准入随会话持有预算与文件 scope。换代/失败/停用先撤销并保留占用，
//! 宿主确认独立 controller 关闭且文件读者退出后才归还。窗口、订阅与 scheduler
//! 的真实操作仍由宿主执行，超时/页面暂停不能充当关闭事实。

use std::cell::Cell;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::access::{Drain, MediaAccess, MediaGrant};
use super::budget::{Allocation, AllocationSnapshot, BudgetCoordinator, BudgetRequest, OwnerKind};
use super::gl_plan::GlAdmission;
use super::jobs::JobError;
use super::media::Container;
use super::target_planner::ResolvedMedia;

/// 恢复预算窗口与次数（§13.3）。
pub(crate) const RECOVERY_WINDOW: Duration = Duration::from_secs(120);
pub(crate) const MAX_RECOVERY_ATTEMPTS: usize = 3;
pub(crate) const MEDIA_PAUSE_LIMIT: Duration = Duration::from_secs(2);

/// 会话状态（§13.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionState {
    Disabled,
    Resolving,
    Preparing,
    Attaching,
    Ready,
    Running,
    Paused,
    Failed,
    WaitingDisplay,
}

impl SessionState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SessionState::Disabled => "disabled",
            SessionState::Resolving => "resolving",
            SessionState::Preparing => "preparing",
            SessionState::Attaching => "attaching",
            SessionState::Ready => "ready",
            SessionState::Running => "running",
            SessionState::Paused => "paused",
            SessionState::Failed => "failed",
            SessionState::WaitingDisplay => "waitingDisplay",
        }
    }
}

/// firstFrameReady 的事实来源（§13.3：三种后端的等价物不同）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameKind {
    /// 图片 img.decode() 完成。
    Image,
    /// 视频首个 requestVideoFrameCallback。
    Video,
    /// WebGL 当前会话真实提交。
    Gl,
}

/// 结构化失败（§14.1 错误形状的会话侧子集）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

/// 暂停原因的作用域（§13.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PauseScope {
    AllPresentations,
    DesktopOnly,
    PreviewOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PauseReason {
    name: String,
    scope: PauseScope,
}

/// ready 四事实。page_handshake 记录匹配的 generation；frame_submitted
/// 记录后端种类（§13.3：状态同时保留 frameSubmitted 与 nativeAttached）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ReadyFacts {
    resource_admitted: bool,
    native_attached: bool,
    page_handshake_generation: Option<u64>,
    frame_submitted: Option<FrameKind>,
}

impl ReadyFacts {
    fn complete(&self) -> bool {
        self.resource_admitted
            && self.native_attached
            && self.page_handshake_generation.is_some()
            && self.frame_submitted.is_some()
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// 诊断快照（§12.4/§13.3 的会话侧字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionDiagnostics {
    pub(crate) state: SessionState,
    pub(crate) generation: u64,
    pub(crate) desired_revision: Option<u64>,
    pub(crate) applied_revision: Option<u64>,
    pub(crate) error: Option<SessionError>,
    /// 生效于本会话的暂停原因（含 previewOnly 的登记，标注其 scope）。
    pub(crate) pause_reasons: Vec<(String, PauseScope)>,
    pub(crate) frame_kind: Option<FrameKind>,
    /// 进入 Paused 的时刻（软暂停 5 分钟强制释放的接线依据，§13.3）。
    pub(crate) paused_at: Option<Instant>,
}

/// apply 的拒绝理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyError {
    /// 恢复预算终态：需要用户明确重试（§13.3）。
    RecoveryExhausted,
}

/// 单次媒体准入的生命周期；仅 WallpaperSession 持有，不能复制资源所有权。
#[derive(Clone, Copy)]
struct PauseCheck {
    token: u64,
    requested_at: Instant,
    confirmed: bool,
}

struct MediaAdmission {
    media: Option<ResolvedMedia>,
    grant: MediaGrant,
    budget: Arc<BudgetCoordinator>,
    request: BudgetRequest,
    token: u64,
    allocations: Vec<Allocation>,
    frame_kind: FrameKind,
    position_ms: Option<u64>,
    pause_sequence: Cell<u64>,
    pause_check: Cell<Option<PauseCheck>>,
    drain: Option<Drain>,
    controller_closed: bool,
    finished: bool,
}

impl std::fmt::Debug for MediaAdmission {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MediaAdmission")
            .field("generation", &self.request.generation)
            .field("token", &self.token)
            .field("frame_kind", &self.frame_kind)
            .field("retiring", &self.drain.is_some())
            .field("controller_closed", &self.controller_closed)
            .finish()
    }
}

impl MediaAdmission {
    fn retire(&mut self) {
        if self.drain.is_none() {
            self.drain = Some(self.grant.revoke());
            let _ = self
                .budget
                .release(self.token, &self.request.session, self.request.generation);
        }
    }

    fn finish(&mut self) -> bool {
        if !self.controller_closed || !self.drain.as_ref().is_some_and(Drain::is_drained) {
            return false;
        }
        // 释放自身的固定句柄/派生目录租约后才归还额度。
        self.media.take();
        for &allocation in &self.allocations {
            if self
                .budget
                .confirm_resource_exit(allocation, &self.request.session, self.request.generation)
                .is_err()
            {
                return false;
            }
        }
        if self
            .budget
            .confirm_exit(self.token, &self.request.session, self.request.generation)
            .is_err()
        {
            return false;
        }
        if self
            .budget
            .forget_released(self.token, &self.request.session, self.request.generation)
            .is_err()
        {
            return false;
        }
        self.finished = true;
        true
    }
}

impl Drop for MediaAdmission {
    fn drop(&mut self) {
        if !self.finished {
            // 丢失宿主回执时保持 stuck 占用，绝不能把 Rust Drop 当作原生退出。
            self.retire();
        }
    }
}

/// 单个壁纸会话的状态机。事件式推进：无效迁移与旧代际事件被忽略并返回
/// false，不 panic——调用方（宿主接线）据此记日志。
#[derive(Debug)]
pub(crate) struct WallpaperSession {
    owner: OwnerKind,
    state: SessionState,
    generation: u64,
    desired_revision: Option<u64>,
    applied_revision: Option<u64>,
    error: Option<SessionError>,
    facts: ReadyFacts,
    pauses: Vec<PauseReason>,
    paused_at: Option<Instant>,
    media: Option<MediaAdmission>,
    retiring_media: Vec<MediaAdmission>,
    last_media_generation: Option<u64>,
    gl: Option<GlAdmission>,
    retiring_gl: Vec<GlAdmission>,
}

impl Default for WallpaperSession {
    fn default() -> Self {
        Self::new()
    }
}

impl WallpaperSession {
    pub(crate) fn new() -> Self {
        Self {
            owner: OwnerKind::Desktop,
            state: SessionState::Disabled,
            generation: 0,
            desired_revision: None,
            applied_revision: None,
            error: None,
            facts: ReadyFacts::default(),
            pauses: Vec::new(),
            paused_at: None,
            media: None,
            retiring_media: Vec::new(),
            last_media_generation: None,
            gl: None,
            retiring_gl: Vec::new(),
        }
    }

    /// Preserve the host's monotonic controller generation when creating a fresh session owner.
    pub(crate) fn after_generation(generation: u64) -> Self {
        Self {
            generation,
            ..Self::new()
        }
    }

    /// Preview has its own lease/controller, but shares the same readiness and exit barriers.
    pub(crate) fn preview_after_generation(generation: u64) -> Self {
        Self {
            owner: OwnerKind::Preview,
            ..Self::after_generation(generation)
        }
    }

    pub(crate) fn state(&self) -> SessionState {
        self.state
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn error(&self) -> Option<&SessionError> {
        self.error.as_ref()
    }

    /// 新意图（§12.3：新的意图取代未提交的旧意图）。代际递增使所有旧代际
    /// 事件失效；终态（恢复预算耗尽）拒绝，等待明确重试。
    /// 返回本次 apply 的 generation。
    pub(crate) fn apply(
        &mut self,
        desired_revision: u64,
        recovery: &RecoveryLedger,
    ) -> Result<u64, ApplyError> {
        if recovery.is_terminal(FaultDomain::Session) {
            return Err(ApplyError::RecoveryExhausted);
        }
        self.retire_current_resources();
        self.generation += 1;
        self.desired_revision = Some(desired_revision);
        self.applied_revision = None;
        self.error = None;
        self.paused_at = None;
        self.facts.clear();
        self.state = SessionState::Resolving;
        Ok(self.generation)
    }

    /// 阶段推进：resolving → preparing → attaching。旧代际/错序事件忽略。
    pub(crate) fn resolved(&mut self, generation: u64) -> bool {
        self.advance_stage(generation, SessionState::Resolving, SessionState::Preparing)
    }

    pub(crate) fn prepared(&mut self, generation: u64) -> bool {
        self.advance_stage(generation, SessionState::Preparing, SessionState::Attaching)
    }

    fn advance_stage(&mut self, generation: u64, from: SessionState, to: SessionState) -> bool {
        if generation != self.generation || self.state != from {
            return false;
        }
        self.state = to;
        true
    }

    /// 单媒体一次性准入：只有当前 attaching 代际可申请；拒绝不改旧权限/状态。
    /// 目标准入必须匹配本会话的桌面/预览 owner。
    pub(crate) fn admit_media(
        &mut self,
        generation: u64,
        media: ResolvedMedia,
        budget: Arc<BudgetCoordinator>,
        access: &MediaAccess,
        owner_session: String,
    ) -> Result<(), JobError> {
        if generation != self.generation
            || self.state != SessionState::Attaching
            || self.media.is_some()
            || self.gl.is_some()
            || self.last_media_generation == Some(generation)
        {
            return Err(JobError::new(
                "stale_generation",
                "媒体准入必须属于尚未加载的当前代际",
            ));
        }
        let plan = media.budget_plan(owner_session, generation)?;
        let request = plan.request().clone();
        if request.owner != self.owner {
            return Err(JobError::invalid_input("呈现目标与会话预算 owner 不匹配"));
        }
        let token = budget.grant_session(&plan)?;
        let mut allocations = Vec::with_capacity(plan.resources().len());
        for resource in plan.resources() {
            match budget.allocate_resource(
                token,
                &request.session,
                generation,
                &resource.id,
                resource.maximum,
            ) {
                Ok(allocation) => allocations.push(allocation),
                Err(error) => {
                    // No scope, page descriptor or I/O was started. Roll back only this
                    // new reservation; another controller's resources stay untouched.
                    let _ = budget.release(token, &request.session, generation);
                    for allocation in allocations {
                        let _ =
                            budget.confirm_resource_exit(allocation, &request.session, generation);
                    }
                    let _ = budget.confirm_exit(token, &request.session, generation);
                    let _ = budget.forget_released(token, &request.session, generation);
                    return Err(error);
                }
            }
        }
        let grant = access.grant_scoped_pinned(
            generation,
            media.reference().package_hash.clone(),
            Arc::clone(&media.input().media),
        );
        let Some(grant) = grant else {
            // 尚未启动媒体/创建读者，只清本笔 token，不 purge 其它代际。
            let _ = budget.release(token, &request.session, generation);
            for allocation in allocations {
                let _ = budget.confirm_resource_exit(allocation, &request.session, generation);
            }
            let _ = budget.confirm_exit(token, &request.session, generation);
            let _ = budget.forget_released(token, &request.session, generation);
            return Err(JobError::new(
                "stale_generation",
                "controller 拒绝旧代际准入",
            ));
        };
        let frame_kind = if media.input().metadata.container == Container::Image {
            FrameKind::Image
        } else {
            FrameKind::Video
        };
        self.media = Some(MediaAdmission {
            media: Some(media),
            grant,
            budget,
            request,
            token,
            allocations,
            frame_kind,
            position_ms: None,
            pause_sequence: Cell::new(0),
            pause_check: Cell::new(None),
            drain: None,
            controller_closed: false,
            finished: false,
        });
        self.last_media_generation = Some(generation);
        // grant 之前的帧属于旧内容，不能替本次媒体补齐 ready。
        self.facts.frame_submitted = None;
        self.set_fact(generation, |facts| facts.resource_admitted = true);
        Ok(())
    }

    pub(crate) fn media_allocation(&self) -> Option<AllocationSnapshot> {
        let media = self.media.as_ref()?;
        media
            .budget
            .allocation_snapshot(
                media.token,
                &media.request.session,
                media.request.generation,
            )
            .ok()
    }

    pub(crate) fn admit_gl(&mut self, mut admission: GlAdmission) -> Result<(), JobError> {
        if admission.generation() != self.generation
            || admission.owner() != self.owner
            || self.state != SessionState::Attaching
            || self.gl.is_some()
            || self.media.is_some()
        {
            return Err(JobError::new(
                "stale_generation",
                "GL 准入必须属于尚未加载的当前代际",
            ));
        }
        admission.published = true;
        self.gl = Some(admission);
        self.facts.frame_submitted = None;
        self.set_fact(self.generation, |facts| facts.resource_admitted = true);
        Ok(())
    }

    pub(crate) fn gl(&self) -> Option<&GlAdmission> {
        self.gl.as_ref()
    }

    /// 页面加载描述只读借用当前已准入计划，不能替换目标或资源。
    pub(crate) fn media(&self) -> Option<&ResolvedMedia> {
        self.media.as_ref()?.media.as_ref()
    }

    pub(crate) fn media_position_ms(&self) -> Option<u64> {
        self.media.as_ref()?.position_ms
    }

    /// Position belongs to the currently admitted video, never to retired/image scopes.
    pub(crate) fn record_media_position(&mut self, generation: u64, position_ms: u64) -> bool {
        let Some(admission) = self.media.as_mut().filter(|admission| {
            generation == self.generation && admission.frame_kind == FrameKind::Video
        }) else {
            return false;
        };
        let duration = admission
            .media
            .as_ref()
            .and_then(|media| media.input().metadata.duration_ms);
        if !duration.is_some_and(|duration| duration > 0 && position_ms < duration) {
            return false;
        }
        admission.position_ms = Some(position_ms);
        true
    }

    /// A stop command is not evidence that the media clock has stopped. Repeated
    /// native stop calls keep the original token and deadline until an actual resume.
    pub(crate) fn request_media_pause(&self, now: Instant) -> Option<u64> {
        let admission = self.media.as_ref().filter(|admission| {
            admission.frame_kind == FrameKind::Video
                && self.facts.frame_submitted == Some(FrameKind::Video)
        })?;
        if let Some(check) = admission.pause_check.get() {
            return Some(check.token);
        }
        let token = admission.pause_sequence.get().wrapping_add(1).max(1);
        admission.pause_sequence.set(token);
        admission.pause_check.set(Some(PauseCheck {
            token,
            requested_at: now,
            confirmed: false,
        }));
        Some(token)
    }

    /// Once the deadline has elapsed, a late resume cannot erase the pending fault
    /// before the host's next lifecycle tick retires the controller.
    pub(crate) fn clear_media_pause(&self, now: Instant) -> bool {
        if self.media_pause_expired(now) {
            return false;
        }
        if let Some(admission) = self.media.as_ref() {
            admission.pause_check.set(None);
        }
        true
    }

    pub(crate) fn confirm_media_pause(&self, generation: u64, token: u64, now: Instant) -> bool {
        let Some(admission) = self
            .media
            .as_ref()
            .filter(|_| generation == self.generation)
        else {
            return false;
        };
        let Some(mut check) = admission.pause_check.get() else {
            return false;
        };
        if check.token != token
            || (!check.confirmed
                && now.saturating_duration_since(check.requested_at) >= MEDIA_PAUSE_LIMIT)
        {
            return false;
        }
        check.confirmed = true;
        admission.pause_check.set(Some(check));
        true
    }

    pub(crate) fn media_pause_expired(&self, now: Instant) -> bool {
        self.media
            .as_ref()
            .and_then(|admission| admission.pause_check.get())
            .is_some_and(|check| {
                !check.confirmed
                    && now.saturating_duration_since(check.requested_at) >= MEDIA_PAUSE_LIMIT
            })
    }

    pub(crate) fn media_pause_confirmed(&self) -> Option<bool> {
        self.media
            .as_ref()?
            .pause_check
            .get()
            .map(|check| check.confirmed)
    }

    fn retire_current_resources(&mut self) {
        if let Some(mut gl) = self.gl.take() {
            gl.retire();
            self.retiring_gl.push(gl);
        }
        if let Some(mut media) = self.media.take() {
            media.retire();
            self.retiring_media.push(media);
        }
    }

    /// 宿主仍需关闭这些代际各自的 controller；超时不自动清除它们。
    pub(crate) fn retiring_generations(&self) -> Vec<u64> {
        self.retiring_media
            .iter()
            .map(|media| media.request.generation)
            .chain(self.retiring_gl.iter().map(GlAdmission::generation))
            .collect()
    }

    /// 仅在对应原生 controller Close 成功且其 surface 销毁后调用。
    /// 活动代际/未知代际拒绝；页面 stop、emptied、错误或超时均不能调用本方法。
    pub(crate) fn controller_closed(&mut self, generation: u64) -> bool {
        if let Some(gl) = self
            .retiring_gl
            .iter_mut()
            .find(|gl| gl.generation() == generation)
        {
            gl.controller_closed();
            return true;
        }
        let Some(media) = self
            .retiring_media
            .iter_mut()
            .find(|media| media.request.generation == generation)
        else {
            return false;
        };
        media.controller_closed = true;
        true
    }

    /// 非阻塞检查关闭与文件流两道屏障；只归还已退出代际自己的 token。
    pub(crate) fn reap_resources(&mut self) -> Vec<u64> {
        let mut finished = Vec::new();
        self.retiring_gl.retain_mut(|gl| {
            if gl.finish() {
                finished.push(gl.generation());
                false
            } else {
                true
            }
        });
        self.retiring_media.retain_mut(|media| {
            if media.finish() {
                finished.push(media.request.generation);
                false
            } else {
                true
            }
        });
        finished
    }

    /// 停用撤销所有当前事实；旧媒体继续等宿主的物理退出回执。
    pub(crate) fn disable(&mut self) {
        self.retire_current_resources();
        self.generation += 1;
        self.state = SessionState::Disabled;
        self.desired_revision = None;
        self.applied_revision = None;
        self.error = None;
        self.paused_at = None;
        self.facts.clear();
    }

    // ---- ready 四事实 ----

    #[cfg(test)]
    pub(crate) fn admit_resources(&mut self, generation: u64) -> bool {
        // 非媒体后端的宿主事实；媒体不得绕过原子准入或复用已回收代际。
        if self.last_media_generation == Some(generation) {
            return false;
        }
        self.set_fact(generation, |facts| facts.resource_admitted = true)
    }

    pub(crate) fn native_attached(&mut self, generation: u64) -> bool {
        self.set_fact(generation, |facts| facts.native_attached = true)
    }

    /// 页面握手：只有当前 generation 的握手成立（§13.3 迟到 ready 不揭幕）。
    pub(crate) fn page_handshake(&mut self, generation: u64) -> bool {
        self.set_fact(generation, |facts| {
            facts.page_handshake_generation = Some(generation);
        })
    }

    pub(crate) fn frame_submitted(&mut self, generation: u64, kind: FrameKind) -> bool {
        if (self.gl.is_some() && kind != FrameKind::Gl)
            || self
                .media
                .as_ref()
                .is_some_and(|media| media.frame_kind != kind)
            || (self.last_media_generation == Some(generation) && self.media.is_none())
        {
            return false;
        }
        self.set_fact(generation, |facts| facts.frame_submitted = Some(kind))
    }

    fn set_fact(&mut self, generation: u64, set: impl FnOnce(&mut ReadyFacts)) -> bool {
        if generation != self.generation || self.state != SessionState::Attaching {
            return false;
        }
        set(&mut self.facts);
        if self.facts.complete() {
            self.state = SessionState::Ready;
            self.applied_revision = self.desired_revision;
        }
        true
    }

    /// 就绪后启动呈现：有生效暂停原因则直接进入 Paused（§13.2），否则 Running。
    pub(crate) fn start_presentation(&mut self, now: Instant) -> bool {
        if self.state != SessionState::Ready {
            return false;
        }
        if self.effective_pause_held() {
            self.enter_paused(now);
        } else {
            self.state = SessionState::Running;
        }
        true
    }

    // ---- 失败与显示器 ----

    /// 结构化失败。旧代际的失败整体忽略（§19.6：迟到/取消结果只做资源
    /// 清理，不得覆盖新代际的诊断与状态）。
    pub(crate) fn fail(
        &mut self,
        generation: u64,
        code: &str,
        message: &str,
        retryable: bool,
    ) -> bool {
        if generation != self.generation {
            return false;
        }
        self.retire_current_resources();
        self.facts.clear();
        self.error = Some(SessionError {
            code: code.to_string(),
            message: message.to_string(),
            retryable,
        });
        self.state = SessionState::Failed;
        true
    }

    /// 目标屏缺席（§13.1 宽限判定后）：呈现让位，资源待恢复时重新准入。
    pub(crate) fn display_missing(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        if !matches!(
            self.state,
            SessionState::Attaching
                | SessionState::Ready
                | SessionState::Running
                | SessionState::Paused
        ) {
            return false;
        }
        self.retire_current_resources();
        self.facts.clear();
        self.paused_at = None;
        self.state = SessionState::WaitingDisplay;
        true
    }

    /// 目标屏恢复：为新 controller 递增代际，再走 attaching/重新准入。
    /// 返回 true 后宿主使用 generation()；缺席前的握手、帧和关闭回执不复用。
    pub(crate) fn display_restored(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.state != SessionState::WaitingDisplay {
            return false;
        }
        self.generation += 1;
        self.state = SessionState::Attaching;
        true
    }

    // ---- 暂停原因集合（§13.2）----

    /// 登记原因；同 (name, scope) 幂等。
    pub(crate) fn add_pause_reason(&mut self, name: &str, scope: PauseScope, now: Instant) {
        let reason = PauseReason {
            name: name.to_string(),
            scope,
        };
        if !self.pauses.contains(&reason) {
            self.pauses.push(reason);
        }
        self.reconcile_pause_state(now);
    }

    /// 解除原因：只移除 (name, scope) 完全匹配的登记，不清空集合。
    /// 返回是否发生了解除。
    pub(crate) fn remove_pause_reason(
        &mut self,
        name: &str,
        scope: PauseScope,
        now: Instant,
    ) -> bool {
        let before = self.pauses.len();
        self.pauses
            .retain(|reason| !(reason.name == name && reason.scope == scope));
        let removed = before != self.pauses.len();
        self.reconcile_pause_state(now);
        removed
    }

    pub(crate) fn pause_reasons(&self) -> Vec<(String, PauseScope)> {
        self.pauses
            .iter()
            .map(|reason| (reason.name.clone(), reason.scope))
            .collect()
    }

    /// 只计算本 owner 范围内的暂停原因（§13.2）。
    fn effective_pause_held(&self) -> bool {
        self.pauses.iter().any(|reason| match self.owner {
            OwnerKind::Preview => !matches!(reason.scope, PauseScope::DesktopOnly),
            _ => !matches!(reason.scope, PauseScope::PreviewOnly),
        })
    }

    fn enter_paused(&mut self, now: Instant) {
        self.state = SessionState::Paused;
        if self.paused_at.is_none() {
            self.paused_at = Some(now);
        }
    }

    fn reconcile_pause_state(&mut self, now: Instant) {
        match self.state {
            SessionState::Running if self.effective_pause_held() => self.enter_paused(now),
            SessionState::Paused if !self.effective_pause_held() => {
                self.state = SessionState::Running;
                self.paused_at = None;
            }
            _ => {}
        }
    }

    pub(crate) fn diagnostics(&self) -> SessionDiagnostics {
        SessionDiagnostics {
            state: self.state,
            generation: self.generation,
            desired_revision: self.desired_revision,
            applied_revision: self.applied_revision,
            error: self.error.clone(),
            pause_reasons: self.pause_reasons(),
            frame_kind: self.facts.frame_submitted,
            paused_at: self.paused_at,
        }
    }
}

/// 恢复预算的故障域（§13.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FaultDomain {
    /// 单会话故障：每个会话一份预算。
    Session,
    /// Explorer 全局重挂：整机一份，不按屏幕数消耗。
    Global,
}

/// 恢复预算账本：窗口内最多 `MAX_RECOVERY_ATTEMPTS` 次；超额进入终态，
/// 时间经过不自动解锁，只有 [`RecoveryLedger::explicit_retry`] 解锁。
#[derive(Debug, Clone)]
pub(crate) struct RecoveryLedger {
    attempts: Vec<(FaultDomain, Instant)>,
    terminal: [bool; 2],
}

impl Default for RecoveryLedger {
    fn default() -> Self {
        Self::new()
    }
}

impl RecoveryLedger {
    pub(crate) fn new() -> Self {
        Self {
            attempts: Vec::new(),
            terminal: [false, false],
        }
    }

    fn slot(domain: FaultDomain) -> usize {
        match domain {
            FaultDomain::Session => 0,
            FaultDomain::Global => 1,
        }
    }

    pub(crate) fn is_terminal(&self, domain: FaultDomain) -> bool {
        self.terminal[Self::slot(domain)]
    }

    /// 记一次恢复尝试。窗口外的旧尝试自然过期；终态后拒绝（时间不解锁）。
    pub(crate) fn charge(&mut self, domain: FaultDomain, now: Instant) -> Result<(), ()> {
        let slot = Self::slot(domain);
        if self.terminal[slot] {
            return Err(());
        }
        self.attempts.retain(|(attempt_domain, at)| {
            *attempt_domain != domain || now.duration_since(*at) < RECOVERY_WINDOW
        });
        self.attempts.push((domain, now));
        let count = self
            .attempts
            .iter()
            .filter(|(attempt_domain, _)| *attempt_domain == domain)
            .count();
        if count > MAX_RECOVERY_ATTEMPTS {
            self.terminal[slot] = true;
            return Err(());
        }
        Ok(())
    }

    /// 用户明确重试：清除终态并重置该域预算（§13.3：只接受用户明确重试）。
    pub(crate) fn explicit_retry(&mut self, domain: FaultDomain, now: Instant) {
        let slot = Self::slot(domain);
        self.terminal[slot] = false;
        self.attempts.retain(|(attempt_domain, at)| {
            *attempt_domain != domain || now.duration_since(*at) >= RECOVERY_WINDOW
        });
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
