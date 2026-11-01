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
//! policy.rs 的常量，不建第二份名字表。本会话是桌面呈现：previewOnly 的
//! 原因不影响其状态。
//!
//! 恢复预算（§13.3）：120 秒最多 3 次，按故障域记账——单会话故障计会话
//! 预算，Explorer 全局重挂计一次全局预算（不按屏幕数消耗）；超额进入
//! 终止态，只接受用户明确重试，时间经过不自动解锁。
//!
//! 退出顺序（订阅、scheduler、视频、scope、controller、worker）是宿主接线
//! 的回收清单，不属于本状态机。

use std::time::{Duration, Instant};

/// 恢复预算窗口与次数（§13.3）。
pub(crate) const RECOVERY_WINDOW: Duration = Duration::from_secs(120);
pub(crate) const MAX_RECOVERY_ATTEMPTS: usize = 3;

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

/// 单个壁纸会话的状态机。事件式推进：无效迁移与旧代际事件被忽略并返回
/// false，不 panic——调用方（宿主接线）据此记日志。
#[derive(Debug, Clone)]
pub(crate) struct WallpaperSession {
    state: SessionState,
    generation: u64,
    desired_revision: Option<u64>,
    applied_revision: Option<u64>,
    error: Option<SessionError>,
    facts: ReadyFacts,
    pauses: Vec<PauseReason>,
    paused_at: Option<Instant>,
}

impl Default for WallpaperSession {
    fn default() -> Self {
        Self::new()
    }
}

impl WallpaperSession {
    pub(crate) fn new() -> Self {
        Self {
            state: SessionState::Disabled,
            generation: 0,
            desired_revision: None,
            applied_revision: None,
            error: None,
            facts: ReadyFacts::default(),
            pauses: Vec::new(),
            paused_at: None,
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
        self.generation += 1;
        self.desired_revision = Some(desired_revision);
        self.applied_revision = None;
        self.error = None;
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

    fn advance_stage(
        &mut self,
        generation: u64,
        from: SessionState,
        to: SessionState,
    ) -> bool {
        if generation != self.generation || self.state != from {
            return false;
        }
        self.state = to;
        true
    }

    // ---- ready 四事实 ----

    pub(crate) fn admit_resources(&mut self, generation: u64) -> bool {
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
        self.set_fact(generation, |facts| facts.frame_submitted = Some(kind))
    }

    fn set_fact(
        &mut self,
        generation: u64,
        set: impl FnOnce(&mut ReadyFacts),
    ) -> bool {
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
        self.facts.clear();
        self.paused_at = None;
        self.state = SessionState::WaitingDisplay;
        true
    }

    /// 目标屏恢复：重新走 attaching（§13.3：卸载后恢复先重新准入）。
    pub(crate) fn display_restored(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.state != SessionState::WaitingDisplay {
            return false;
        }
        self.state = SessionState::Attaching;
        true
    }

    // ---- 暂停原因集合（§13.2）----

    /// 登记原因；同 (name, scope) 幂等。
    pub(crate) fn add_pause_reason(&mut self, name: &str, scope: PauseScope, now: Instant) {
        let reason = PauseReason { name: name.to_string(), scope };
        if !self.pauses.contains(&reason) {
            self.pauses.push(reason);
        }
        self.reconcile_pause_state(now);
    }

    /// 解除原因：只移除 (name, scope) 完全匹配的登记，不清空集合。
    /// 返回是否发生了解除。
    pub(crate) fn remove_pause_reason(&mut self, name: &str, scope: PauseScope, now: Instant) -> bool {
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

    /// 生效于本桌面会话的原因（previewOnly 不算，§13.2）。
    fn effective_pause_held(&self) -> bool {
        self.pauses
            .iter()
            .any(|reason| !matches!(reason.scope, PauseScope::PreviewOnly))
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
        self.attempts
            .retain(|(attempt_domain, at)| {
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
        self.attempts
            .retain(|(attempt_domain, at)| {
                *attempt_domain != domain || now.duration_since(*at) >= RECOVERY_WINDOW
            });
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
