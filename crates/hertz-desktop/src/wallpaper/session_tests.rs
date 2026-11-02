// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 会话状态机测试（P1-04b）：ready 四事实、迟到代际、恢复预算终态、
//! 故障域分离与 §13.2 scoped 暂停原因。

use std::time::{Duration, Instant};

use super::super::policy::{REASON_BATTERY, REASON_FULLSCREEN, REASON_MANUAL_PAUSE};
use super::{
    ApplyError, FaultDomain, FrameKind, PauseScope, RecoveryLedger, SessionState, WallpaperSession,
    MAX_RECOVERY_ATTEMPTS, RECOVERY_WINDOW,
};

fn base() -> Instant {
    Instant::now()
}

/// 推进到 attaching（resolved+prepared）。
fn to_attaching(session: &mut WallpaperSession, recovery: &RecoveryLedger, revision: u64) -> u64 {
    let generation = session.apply(revision, recovery).expect("apply");
    assert!(session.resolved(generation));
    assert!(session.prepared(generation));
    generation
}

/// 补齐除指定缺失项外的全部事实。
fn submit_facts_but(session: &mut WallpaperSession, generation: u64, missing: usize) {
    if missing != 0 {
        assert!(session.admit_resources(generation));
    }
    if missing != 1 {
        assert!(session.native_attached(generation));
    }
    if missing != 2 {
        assert!(session.page_handshake(generation));
    }
    if missing != 3 {
        assert!(session.frame_submitted(generation, FrameKind::Gl));
    }
}

#[test]
fn happy_path_reaches_running_with_applied_revision() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    assert_eq!(session.state(), SessionState::Disabled);

    let generation = to_attaching(&mut session, &recovery, 7);
    submit_facts_but(&mut session, generation, usize::MAX);
    assert_eq!(session.state(), SessionState::Ready);

    let now = base();
    assert!(session.start_presentation(now));
    assert_eq!(session.state(), SessionState::Running);

    let diagnostics = session.diagnostics();
    assert_eq!(diagnostics.applied_revision, Some(7));
    assert_eq!(diagnostics.desired_revision, Some(7));
    assert_eq!(diagnostics.generation, generation);
    assert_eq!(diagnostics.frame_kind, Some(FrameKind::Gl));
    assert_eq!(diagnostics.error, None);
}

#[test]
fn a_new_generation_does_not_inherit_the_previous_pause_duration() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let generation = to_attaching(&mut session, &recovery, 1);
    submit_facts_but(&mut session, generation, usize::MAX);
    session.start_presentation(base());
    session.add_pause_reason(REASON_MANUAL_PAUSE, PauseScope::DesktopOnly, base());
    assert!(session.diagnostics().paused_at.is_some());
    session.apply(2, &recovery).unwrap();
    assert_eq!(session.diagnostics().paused_at, None);
}

/// ready 缺一不可：任一事实缺失都停在 attaching（§13.3）。
#[test]
fn ready_requires_all_four_facts() {
    for missing in 0..4 {
        let recovery = RecoveryLedger::new();
        let mut session = WallpaperSession::new();
        let generation = to_attaching(&mut session, &recovery, 1);
        submit_facts_but(&mut session, generation, missing);
        assert_eq!(
            session.state(),
            SessionState::Attaching,
            "缺第 {missing} 号事实时不得就绪"
        );
    }
}

/// 新意图取代旧意图（§12.3），旧代际事件整体失效（§13.3 迟到不揭幕）。
#[test]
fn stale_generation_events_are_ignored() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let stale = to_attaching(&mut session, &recovery, 1);

    let generation = session.apply(2, &recovery).expect("新意图");
    assert!(generation > stale, "apply 必须递增代际");
    assert_eq!(session.state(), SessionState::Resolving);

    // 旧代际的推进与事实全部被忽略。
    assert!(!session.resolved(stale));
    assert!(!session.prepared(stale));
    assert!(!session.admit_resources(stale));
    assert!(!session.native_attached(stale));
    assert!(!session.page_handshake(stale));
    assert!(!session.frame_submitted(stale, FrameKind::Video));
    assert!(!session.display_missing(stale));
    assert!(!session.fail(stale, "media_error", "迟到失败", true));
    assert_eq!(session.state(), SessionState::Resolving);
    assert_eq!(session.error(), None, "迟到失败不得覆盖新代际诊断");

    // 新代际照常推进。
    assert!(session.resolved(generation));
    assert!(session.prepared(generation));
    assert!(session.frame_submitted(generation, FrameKind::Video));
    assert_eq!(session.state(), SessionState::Attaching);
}

/// 失败进入 failed，结构化 error 可查；重新 apply 清error开新代际。
#[test]
fn fail_enters_failed_with_structured_error() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let generation = session.apply(3, &recovery).expect("apply");
    assert!(session.resolved(generation));
    assert!(session.fail(generation, "media_error_4", "容器不受支持", false));

    assert_eq!(session.state(), SessionState::Failed);
    let error = session.error().expect("error 必须记录");
    assert_eq!(error.code, "media_error_4");
    assert!(!error.retryable);

    // 新尝试清 error；不可重试的错误也允许用户显式换作品再试。
    let generation = session.apply(4, &recovery).expect("重新 apply");
    assert_eq!(session.error(), None);
    assert_eq!(session.state(), SessionState::Resolving);
    assert!(session.resolved(generation));
}

/// 显示器缺席/恢复：资源事实清空，恢复后重新准入（§13.1/§13.3）。
#[test]
fn display_missing_then_restore_re_admits() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let now = base();
    let generation = to_attaching(&mut session, &recovery, 5);
    submit_facts_but(&mut session, generation, usize::MAX);
    session.start_presentation(now);
    assert_eq!(session.state(), SessionState::Running);

    assert!(session.display_missing(generation));
    assert_eq!(session.state(), SessionState::WaitingDisplay);
    // 已应用的意图保留（布局引用不变，§7.2），只是没有呈现可看。
    assert_eq!(session.diagnostics().applied_revision, Some(5));

    assert!(session.display_restored(generation));
    assert_eq!(session.state(), SessionState::Attaching);
    let restored = session.generation();
    assert!(restored > generation, "重新建窗不复用旧代际");
    assert!(!session.page_handshake(generation));
    assert!(!session.frame_submitted(generation, FrameKind::Gl));
    assert!(!session.native_attached(generation));
    submit_facts_but(&mut session, restored, usize::MAX);
    assert_eq!(session.state(), SessionState::Ready);

    // resolving 阶段的缺席判定无效（§13.1 宽限属策略层）。
    let generation = session.apply(6, &recovery).expect("apply");
    assert!(
        !session.display_missing(generation),
        "resolving 阶段不判缺席"
    );
    assert_eq!(session.state(), SessionState::Resolving);
}

/// §13.2：原因独立增删、scope 匹配才解除、previewOnly 不影响桌面会话。
#[test]
fn pause_reasons_are_scoped_and_independent() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let now = base();
    let generation = to_attaching(&mut session, &recovery, 1);
    submit_facts_but(&mut session, generation, usize::MAX);
    session.start_presentation(now);
    assert_eq!(session.state(), SessionState::Running);

    // 手动暂停后，解锁/唤醒类原因解除不会自动恢复（manualPause 独立保留）。
    session.add_pause_reason(REASON_MANUAL_PAUSE, PauseScope::AllPresentations, now);
    session.add_pause_reason(REASON_MANUAL_PAUSE, PauseScope::AllPresentations, now);
    assert_eq!(session.state(), SessionState::Paused);
    assert_eq!(session.pause_reasons().len(), 1, "同 (name, scope) 幂等");

    session.add_pause_reason(REASON_BATTERY, PauseScope::AllPresentations, now);
    assert_eq!(session.state(), SessionState::Paused);
    assert!(session.remove_pause_reason(REASON_BATTERY, PauseScope::AllPresentations, now));
    assert_eq!(session.state(), SessionState::Paused, "manualPause 仍生效");

    // scope 不匹配的解除不生效。
    assert!(!session.remove_pause_reason(REASON_MANUAL_PAUSE, PauseScope::DesktopOnly, now));
    assert_eq!(session.pause_reasons().len(), 1);

    assert!(session.remove_pause_reason(REASON_MANUAL_PAUSE, PauseScope::AllPresentations, now));
    assert_eq!(session.state(), SessionState::Running);

    // previewOnly 不 pause 桌面会话。
    session.add_pause_reason("aiGeneration", PauseScope::PreviewOnly, now);
    assert_eq!(
        session.state(),
        SessionState::Running,
        "previewOnly 不影响桌面呈现"
    );
    session.add_pause_reason(REASON_FULLSCREEN, PauseScope::DesktopOnly, now);
    assert_eq!(session.state(), SessionState::Paused);
    assert!(session.remove_pause_reason(REASON_FULLSCREEN, PauseScope::DesktopOnly, now));
    assert_eq!(
        session.state(),
        SessionState::Running,
        "previewOnly 单独存在时恢复"
    );

    // 就绪但未启动呈现：登记原因不改变 ready 态，启动时直接进入 paused。
    let generation = session.apply(2, &recovery).expect("apply");
    assert!(session.resolved(generation));
    assert!(session.prepared(generation));
    submit_facts_but(&mut session, generation, usize::MAX);
    assert_eq!(session.state(), SessionState::Ready);
    session.add_pause_reason(REASON_MANUAL_PAUSE, PauseScope::AllPresentations, now);
    assert_eq!(
        session.state(),
        SessionState::Ready,
        "ready 态不受暂停原因影响"
    );
    session.start_presentation(now);
    assert_eq!(session.state(), SessionState::Paused, "启动即暂停");
    assert!(session.diagnostics().paused_at.is_some());
}

/// 恢复预算：窗口内超限进入终态；时间经过不自动解锁；明确重试才解锁。
#[test]
fn recovery_terminal_requires_explicit_retry() {
    let mut ledger = RecoveryLedger::new();
    let now = base();
    for attempt in 0..MAX_RECOVERY_ATTEMPTS as u64 {
        assert!(
            ledger
                .charge(FaultDomain::Session, now + Duration::from_secs(attempt))
                .is_ok(),
            "第 {} 次恢复必须允许",
            attempt + 1
        );
    }
    assert!(ledger
        .charge(FaultDomain::Session, now + Duration::from_secs(3))
        .is_err());
    assert!(ledger.is_terminal(FaultDomain::Session));

    // 时间经过不解锁（§13.3）。
    let later = now + RECOVERY_WINDOW + Duration::from_secs(60);
    assert!(ledger.charge(FaultDomain::Session, later).is_err());
    assert!(ledger.is_terminal(FaultDomain::Session));

    // 用户明确重试：解锁并重置预算。
    ledger.explicit_retry(FaultDomain::Session, later);
    assert!(!ledger.is_terminal(FaultDomain::Session));
    assert!(ledger.charge(FaultDomain::Session, later).is_ok());
}

/// 故障域分离：全局重挂预算独立于单会话预算（§13.3 不按屏幕数消耗）。
#[test]
fn recovery_domains_are_independent() {
    let mut ledger = RecoveryLedger::new();
    let now = base();
    for attempt in 0..MAX_RECOVERY_ATTEMPTS as u64 {
        ledger
            .charge(FaultDomain::Global, now + Duration::from_secs(attempt))
            .expect("全局恢复在预算内");
    }
    assert!(ledger
        .charge(FaultDomain::Global, now + Duration::from_secs(3))
        .is_err());
    assert!(ledger.is_terminal(FaultDomain::Global));

    // 全局终态不影响会话域预算；会话域终态也不影响全局。
    assert!(
        ledger.charge(FaultDomain::Session, now).is_ok(),
        "全局耗尽不得消耗会话域预算"
    );
    ledger.explicit_retry(FaultDomain::Global, now);
    assert!(ledger.charge(FaultDomain::Global, now).is_ok());
}

/// 会话终态拒绝新 apply（只接受用户明确重试）；全局终态不拦 apply——
/// 用户主动换作品本身就是明确动作，全局重挂的解锁由接线层调 explicit_retry。
#[test]
fn session_terminal_blocks_apply_until_explicit_retry() {
    let mut ledger = RecoveryLedger::new();
    let now = base();
    for attempt in 0..=MAX_RECOVERY_ATTEMPTS as u64 {
        let _ = ledger.charge(FaultDomain::Session, now + Duration::from_secs(attempt));
    }
    assert!(ledger.is_terminal(FaultDomain::Session));

    let mut session = WallpaperSession::new();
    assert_eq!(
        session.apply(1, &ledger),
        Err(ApplyError::RecoveryExhausted),
        "终态必须拒绝新 apply"
    );
    assert_eq!(session.state(), SessionState::Disabled, "拒绝不得改状态");

    ledger.explicit_retry(FaultDomain::Session, now);
    assert!(session.apply(1, &ledger).is_ok(), "明确重试后放行");

    // 全局终态不拦 apply（见测试注释）。
    let mut ledger = RecoveryLedger::new();
    for attempt in 0..=MAX_RECOVERY_ATTEMPTS as u64 {
        let _ = ledger.charge(FaultDomain::Global, now + Duration::from_secs(attempt));
    }
    let mut session = WallpaperSession::new();
    assert!(session.apply(1, &ledger).is_ok());
}

/// apply 取代未提交旧意图：desired 跟随最新，applied 在就绪前为空。
#[test]
fn apply_supersedes_pending_intent() {
    let recovery = RecoveryLedger::new();
    let mut session = WallpaperSession::new();
    let first = session.apply(10, &recovery).expect("apply 1");
    assert!(session.resolved(first));
    let second = session.apply(11, &recovery).expect("apply 2");
    assert!(second > first);
    assert_eq!(session.diagnostics().desired_revision, Some(11));
    assert_eq!(session.diagnostics().applied_revision, None);
    // 旧代际 prepared 无效，新代际正常。
    assert!(!session.prepared(first));
    assert!(session.resolved(second));
    assert!(session.prepared(second));
}

#[test]
fn preview_session_ignores_desktop_pauses_and_respects_its_own_scope() {
    let mut session = WallpaperSession::preview_after_generation(4);
    let generation = to_attaching(&mut session, &RecoveryLedger::new(), 8);
    assert_eq!(generation, 5);
    submit_facts_but(&mut session, generation, usize::MAX);
    let now = base();
    assert!(session.start_presentation(now));
    session.add_pause_reason(REASON_MANUAL_PAUSE, PauseScope::DesktopOnly, now);
    assert_eq!(session.state(), SessionState::Running);
    session.add_pause_reason(REASON_BATTERY, PauseScope::PreviewOnly, now);
    assert_eq!(session.state(), SessionState::Paused);
    session.remove_pause_reason(REASON_BATTERY, PauseScope::PreviewOnly, now);
    assert_eq!(session.state(), SessionState::Running);
    session.add_pause_reason(REASON_BATTERY, PauseScope::AllPresentations, now);
    assert_eq!(session.state(), SessionState::Paused);
}
