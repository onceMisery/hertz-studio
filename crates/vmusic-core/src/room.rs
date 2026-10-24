// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 房间播控的计划契约与 §8.2 时序状态机（lan-listening P0 冻结的最小协议状态机）。
//!
//! 可执行语义覆盖：命令受理（操作键去重 + 顺序水位 + revision 检查）→
//! `preparing`（可被更新意图取代为 `superseded`）→ 接收端对具体计划的 Ready
//! 门禁 → Commit 发布（前缀冻结、不可再 superseded）→ 到 `effective_at` 时
//! `applied`（恰好一次）。呈现事实只随生效边界提交：提前渲染不提前改歌名。
//!
//! 本模块只含确定性语义：时间由调用方以纳秒注入，没有线程、网络、存储或
//! 音频依赖。队列与计划游标归 AppState（§5.2「唯一归属」），调用方在提交
//! `Next`/`Seek` 前自行按权威游标解析目标实例；P2 的传输层只把这些类型映射
//! 到 LAN 协议。完成事实沿用既有词汇（applied / no_op / superseded），操作键
//! 对齐 `clientOperationId` 幂等语义，不引入第二套结果口径。
//!
//! 仿真测试即 P0 门槛「8.2 时序仿真通过」的机器可查形式；接收侧的
//! 代际/Ready/Commit 音频门禁（PCM 先于 Format/Plan、Commit 迟到不追播等
//! §12.3 反例）在子模块 [`receiver`]，同属 P0 冻结的最小协议状态机。

pub mod receiver;

use std::collections::{HashMap, VecDeque};

/// 单调纳秒时间。由调用方注入；不对应任何真实时钟。
pub type Nanos = u64;

/// 计划 ID：一次准备中的候选方案的稳定标识。修改锚点/格式/边界必须换新 ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlanId(pub u64);

/// 媒体连续性代际。换率、暂停、停止、seek、强制切歌、恢复都要换代际。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Epoch(pub u64);

/// 播放实例 ID：同一曲目重复排队也有不同实例（§5.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrackInstanceId(pub u64);

/// 成员 ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MemberId(pub u32);

/// 音频输出端 ID（接收端租约的主体，含房主本机 Receiver）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EndpointId(pub u32);

/// 控制 revision：只随权威控制状态变化，进度/心跳/遥测不碰它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Revision(pub u64);

/// 操作键：命名空间 + 会话内单调序号（§8.3）。命名空间隔离播控、聊天等族。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OperationKey {
    pub member: MemberId,
    pub namespace: u32,
    pub seq: u64,
}

/// 受理的播控命令。`Next`/`Seek` 携带调用方按权威计划游标解析后的实例。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Play,
    Pause,
    Stop,
    Next {
        to: TrackInstanceId,
    },
    Seek {
        track: TrackInstanceId,
        position_ms: u64,
    },
}

/// 计划目标：生效时应呈现的曲目、位置与播放态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanTarget {
    pub track: TrackInstanceId,
    pub position_ms: u64,
    pub playing: bool,
}

/// 一个候选/已发布计划。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub id: PlanId,
    pub epoch: Epoch,
    pub target: PlanTarget,
    /// 生效期限（房主单调时钟）。发布后前缀冻结，不可倒退。
    pub effective_at: Nanos,
    pub created_by: OperationKey,
}

/// 操作的当前结果。`preparing` 是受理回执，不是终态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 受理并准备中；尚可被更新意图取代。
    Preparing { plan: PlanId },
    /// 被更新意图取代（仅 Commit 前可能）。
    Superseded { by: PlanId },
    /// 无动作（命令未改变任何目标）。
    NoOp,
    /// 准备失败，不修改当前可听前缀。
    Failed { reason: PlanFailure },
    /// Commit 已发布，前缀已冻结。
    Scheduled { plan: PlanId, effective_at: Nanos },
    /// 已到生效点提交。证明房主时间线生效，不证明每台设备已出声。
    Applied { plan: PlanId, at: Nanos },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanFailure {
    /// seek 绑定的实例已不是当前/待生效目标（队列已前进）。
    StaleTrackInstance,
    /// Next 解析不到后继（队列耗尽）。
    NoSuccessor,
    OutputNotReady,
    DecodeFailed,
}

impl PlanFailure {
    pub fn code(&self) -> &'static str {
        match self {
            PlanFailure::StaleTrackInstance => "stale_track_instance",
            PlanFailure::NoSuccessor => "no_successor",
            PlanFailure::OutputNotReady => "no_ready_endpoint",
            PlanFailure::DecodeFailed => "decode_failed",
        }
    }
}

/// 受理拒绝。对外错误码对齐 §8.3 的区分要求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitError {
    /// 同一操作键携带了不同内容。
    KeyContentConflict,
    /// 预期 revision 不符。
    RevisionConflict,
    /// 一个未生效已发布计划 + 一个准备中意图已占满。
    Busy,
    /// 命名空间内乱序的低序号新键。
    StaleSequence,
    /// 操作键已过期/未知；不得当作新操作执行。
    OperationUnknown,
}

impl SubmitError {
    pub fn code(&self) -> &'static str {
        match self {
            SubmitError::KeyContentConflict => "operation_key_conflict",
            SubmitError::RevisionConflict => "revision_conflict",
            SubmitError::Busy => "room_busy",
            SubmitError::StaleSequence => "operation_stale",
            SubmitError::OperationUnknown => "operation_unknown",
        }
    }
}

/// Commit 发布拒绝。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitError {
    /// 没有准备中的意图可发布。
    NothingPreparing,
    /// 初次起播需要至少一个音频输出端对候选计划 Ready。
    NotReady,
    /// 生效期限早于「发送 + 转换 + 设备提交提前量 + 安全余量」。
    EffectiveTooSoon,
    /// 已有一个未生效的已发布计划；先等它 applied。
    PreviousPlanPending,
}

impl CommitError {
    pub fn code(&self) -> &'static str {
        match self {
            CommitError::NothingPreparing => "nothing_preparing",
            CommitError::NotReady => "no_ready_endpoint",
            CommitError::EffectiveTooSoon => "effective_too_soon",
            CommitError::PreviousPlanPending => "previous_plan_pending",
        }
    }
}

/// 操作结果的有界保留：每会话最近 `CAPACITY` 条、最长 `TTL`（§8.3）。
const OUTCOME_CAPACITY: usize = 256;
const OUTCOME_TTL: Nanos = 10 * 60 * 1_000_000_000;

struct Preparing {
    key: OperationKey,
    /// 创建命令原样保留：被取代后同键重试的内容比对仍按原命令执行。
    content: Command,
    plan: Plan,
    ready: Vec<EndpointId>,
}

struct RecordedOutcome {
    content: Command,
    outcome: Outcome,
    recorded_at: Nanos,
}

/// §8.2 计划状态机。所有方法纯确定性：同输入同输出，时间显式注入。
pub struct PlanScheduler {
    revision: Revision,
    next_plan: u64,
    epoch: u64,
    /// 已提交的呈现事实（歌名/位置/历史按它更新）。
    presentation: PlanTarget,
    /// 已发布未生效的计划，至多一个。
    published: Option<Plan>,
    /// 准备中的意图，至多一个，可合并（被新意图取代）。
    preparing: Option<Preparing>,
    outcomes: HashMap<OperationKey, RecordedOutcome>,
    order: VecDeque<OperationKey>,
    /// 每 (member, namespace) 的已受理序号高水位。
    high_water: HashMap<(MemberId, u32), u64>,
    has_started: bool,
}

impl PlanScheduler {
    /// Cancel only the unpublished candidate. The committed prefix remains
    /// immutable, and retries observe the terminal failure under the same key.
    pub fn retarget_preparing(&mut self, plan: PlanId, target: PlanTarget) -> bool {
        let Some(p) = self.preparing.as_mut().filter(|p| p.plan.id == plan) else {
            return false;
        };
        p.plan.target = target;
        true
    }
    pub fn fail_preparing(&mut self, plan: PlanId, reason: PlanFailure) -> bool {
        if self.preparing.as_ref().is_none_or(|p| p.plan.id != plan) {
            return false;
        }
        let pending = self.preparing.take().unwrap();
        if let Some(record) = self.outcomes.get_mut(&pending.key) {
            record.outcome = Outcome::Failed { reason };
        }
        self.revision = Revision(self.revision.0.saturating_add(1));
        true
    }

    /// Natural track promotions are presentation facts from the renderer.
    /// They never supersede a committed control plan.
    pub fn observe_transition(&mut self, target: PlanTarget) {
        self.presentation = target;
    }
    /// Non-timeline control edits (queue/mode/gain) share the same revision.
    /// Progress observations never call this method.
    pub fn control_changed(&mut self) -> Option<Revision> {
        self.revision = Revision(self.revision.0.checked_add(1)?);
        Some(self.revision)
    }

    /// Refresh the currently audible track position without changing control
    /// revision. Pending target identity remains owned by its accepted plan.
    pub fn observe_position(&mut self, track: TrackInstanceId, position_ms: u64) {
        if self.presentation.track == track {
            self.presentation.position_ms = position_ms;
        }
    }
    /// `initial` 是进入房间前或上次停止后的当前呈现事实。
    pub fn new(initial: PlanTarget) -> Self {
        Self {
            revision: Revision(1),
            next_plan: 1,
            epoch: 1,
            presentation: initial,
            published: None,
            preparing: None,
            outcomes: std::collections::HashMap::new(),
            order: VecDeque::new(),
            high_water: std::collections::HashMap::new(),
            has_started: initial.playing,
        }
    }

    pub fn revision(&self) -> Revision {
        self.revision
    }

    pub fn epoch(&self) -> Epoch {
        Epoch(self.epoch)
    }

    /// 当前呈现事实（呈现边界提交后的世界）。
    pub fn presentation(&self) -> PlanTarget {
        self.presentation
    }

    /// 已发布未生效的计划。
    pub fn published(&self) -> Option<Plan> {
        self.published
    }

    /// 准备中的候选计划（含计划 ID，供接收端 Ready 引用）。
    pub fn preparing(&self) -> Option<Plan> {
        self.preparing.as_ref().map(|p| p.plan)
    }

    /// 待裁决目标：准备中意图 > 已发布计划 > 当前呈现。
    pub fn pending_target(&self) -> PlanTarget {
        if let Some(p) = &self.preparing {
            return p.plan.target;
        }
        if let Some(p) = &self.published {
            return p.target;
        }
        self.presentation
    }

    /// 查询操作当前结果；过期/未知键明确拒绝，不当作新操作。
    pub fn poll(&mut self, now: Nanos, key: OperationKey) -> Result<Outcome, SubmitError> {
        self.evict(now);
        self.outcomes
            .get(&key)
            .map(|r| r.outcome)
            .ok_or(SubmitError::OperationUnknown)
    }

    /// 受理命令。串行裁决：先同键结果，再顺序水位与 revision，最后语义合并。
    pub fn submit(
        &mut self,
        now: Nanos,
        key: OperationKey,
        expected_revision: Option<Revision>,
        command: Command,
    ) -> Result<Outcome, SubmitError> {
        self.evict(now);
        // 先查同键结果：重试不重复执行。
        if let Some(record) = self.outcomes.get(&key) {
            if record.content != command {
                return Err(SubmitError::KeyContentConflict);
            }
            return Ok(record.outcome);
        }
        // 乱序/过期低序号：明确拒绝，不排队。
        let water = self
            .high_water
            .get(&(key.member, key.namespace))
            .copied()
            .unwrap_or(0);
        if key.seq <= water {
            return Err(SubmitError::OperationUnknown);
        }
        if let Some(expected) = expected_revision {
            if expected != self.revision {
                return Err(SubmitError::RevisionConflict);
            }
        }
        if self.published.is_some() && self.preparing.is_some() {
            return Err(SubmitError::Busy);
        }
        // 已发布计划生效后前缀冻结：新命令排在已发布计划之后，从它的目标出发。
        let base = self.pending_target();
        let plan_epoch = Epoch(self.epoch + 1);
        let target = match command {
            Command::Play => {
                if base.playing {
                    self.record(now, key, command, Outcome::NoOp);
                    return Ok(Outcome::NoOp);
                }
                PlanTarget {
                    playing: true,
                    ..base
                }
            }
            Command::Pause => {
                if !base.playing {
                    self.record(now, key, command, Outcome::NoOp);
                    return Ok(Outcome::NoOp);
                }
                PlanTarget {
                    playing: false,
                    ..base
                }
            }
            Command::Stop => PlanTarget {
                position_ms: 0,
                playing: false,
                ..base
            },
            Command::Next { to } => PlanTarget {
                track: to,
                position_ms: 0,
                playing: true,
            },
            Command::Seek { track, position_ms } => {
                if track != base.track {
                    self.record(
                        now,
                        key,
                        command,
                        Outcome::Failed {
                            reason: PlanFailure::StaleTrackInstance,
                        },
                    );
                    return Ok(Outcome::Failed {
                        reason: PlanFailure::StaleTrackInstance,
                    });
                }
                if position_ms == base.position_ms {
                    self.record(now, key, command, Outcome::NoOp);
                    return Ok(Outcome::NoOp);
                }
                PlanTarget {
                    position_ms,
                    ..base
                }
            }
        };
        // 新意图取代旧准备中意图；已发布计划不受影响（不可撤销）。
        let plan_id = PlanId(self.next_plan);
        self.next_plan += 1;
        if let Some(old) = self.preparing.take() {
            self.outcomes.insert(
                old.key,
                RecordedOutcome {
                    content: old.content,
                    outcome: Outcome::Superseded { by: plan_id },
                    recorded_at: now,
                },
            );
            // 保留原插入序：老键已在 order 里，无需重复入队。
        }
        self.epoch += 1;
        self.preparing = Some(Preparing {
            key,
            content: command,
            plan: Plan {
                id: plan_id,
                epoch: plan_epoch,
                target,
                effective_at: 0,
                created_by: key,
            },
            ready: Vec::new(),
        });
        self.revision = Revision(self.revision.0 + 1);
        self.record(now, key, command, Outcome::Preparing { plan: plan_id });
        Ok(Outcome::Preparing { plan: plan_id })
    }

    /// 接收端对具体计划 Ready。计划 ID 不匹配（旧会话/已被取代）返回 false，
    /// 不得复活任何东西。
    pub fn report_ready(&mut self, endpoint: EndpointId, plan: PlanId) -> bool {
        let Some(p) = self.preparing.as_mut() else {
            return false;
        };
        if p.plan.id != plan {
            return false;
        }
        if !p.ready.contains(&endpoint) {
            p.ready.push(endpoint);
        }
        true
    }

    /// 原子冻结切换边界并发布 Commit。
    pub fn commit(
        &mut self,
        now: Nanos,
        effective_at: Nanos,
        min_lead: Nanos,
    ) -> Result<PlanId, CommitError> {
        if self.published.is_some() {
            return Err(CommitError::PreviousPlanPending);
        }
        let Some(p) = self.preparing.as_ref() else {
            return Err(CommitError::NothingPreparing);
        };
        if !self.has_started && p.plan.target.playing && p.ready.is_empty() {
            return Err(CommitError::NotReady);
        }
        if effective_at < now.saturating_add(min_lead) {
            return Err(CommitError::EffectiveTooSoon);
        }
        let key = p.key;
        let mut plan = p.plan;
        plan.effective_at = effective_at;
        self.preparing = None;
        self.published = Some(plan);
        self.has_started |= plan.target.playing;
        self.revision = Revision(self.revision.0 + 1);
        if let Some(record) = self.outcomes.get_mut(&key) {
            record.outcome = Outcome::Scheduled {
                plan: plan.id,
                effective_at,
            };
        }
        Ok(plan.id)
    }

    /// 推进到 `now`：把已过生效期限的已发布计划按序提交，恰好一次。
    pub fn advance(&mut self, now: Nanos) {
        let Some(plan) = self.published else {
            return;
        };
        if plan.effective_at > now {
            return;
        }
        self.presentation = plan.target;
        self.published = None;
        if let Some(record) = self.outcomes.get_mut(&plan.created_by) {
            // 只有还停在 preparing/scheduled 的创建者操作才落 applied：
            // superseded 的意图不被后续计划复活。
            if matches!(
                record.outcome,
                Outcome::Preparing { .. } | Outcome::Scheduled { .. }
            ) {
                record.outcome = Outcome::Applied {
                    plan: plan.id,
                    at: plan.effective_at,
                };
            }
        }
    }

    fn record(&mut self, now: Nanos, key: OperationKey, content: Command, outcome: Outcome) {
        // 所有已受理结果（包括 NoOp/Failed）都消费操作序号；重试先查结果。
        self.high_water.insert((key.member, key.namespace), key.seq);
        self.order.push_back(key);
        self.outcomes.insert(
            key,
            RecordedOutcome {
                content,
                outcome,
                recorded_at: now,
            },
        );
    }

    /// 容量 + TTL 双约束淘汰；条数、时间任一先到即清理最旧记录。
    fn evict(&mut self, now: Nanos) {
        while self.order.len() > OUTCOME_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.outcomes.remove(&oldest);
            }
        }
        while let Some(oldest) = self.order.front() {
            let Some(record) = self.outcomes.get(oldest) else {
                self.order.pop_front();
                continue;
            };
            if now.saturating_sub(record.recorded_at) > OUTCOME_TTL {
                let oldest = *oldest;
                self.outcomes.remove(&oldest);
                self.order.pop_front();
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Nanos = 1_000_000;
    const TRACK_A: TrackInstanceId = TrackInstanceId(1);
    const TRACK_B: TrackInstanceId = TrackInstanceId(2);
    const TRACK_C: TrackInstanceId = TrackInstanceId(3);

    fn key(seq: u64) -> OperationKey {
        OperationKey {
            member: MemberId(7),
            namespace: 1,
            seq,
        }
    }

    fn stopped(track: TrackInstanceId) -> PlanTarget {
        PlanTarget {
            track,
            position_ms: 0,
            playing: false,
        }
    }

    #[test]
    fn noop_and_failed_operations_advance_watermark_without_changing_revision() {
        for command in [
            Command::Play,
            Command::Seek {
                track: TRACK_B,
                position_ms: 100,
            },
        ] {
            let mut room = PlanScheduler::new(playing(TRACK_A, 0));
            let revision = room.revision();
            let outcome = room.submit(0, key(10), None, command).unwrap();
            assert!(matches!(outcome, Outcome::NoOp | Outcome::Failed { .. }));
            assert_eq!(room.revision(), revision);
            assert_eq!(
                room.submit(1, key(9), None, Command::Pause),
                Err(SubmitError::OperationUnknown)
            );
            assert_eq!(room.submit(2, key(10), None, command), Ok(outcome));
            // 结果过期后，高水位也必须阻止旧操作重新执行。
            assert_eq!(
                room.submit(OUTCOME_TTL + 1, key(10), None, command),
                Err(SubmitError::OperationUnknown)
            );
            assert!(matches!(
                room.submit(OUTCOME_TTL + 2, key(11), None, Command::Pause),
                Ok(Outcome::Preparing { .. })
            ));
        }
    }

    fn playing(track: TrackInstanceId, position_ms: u64) -> PlanTarget {
        PlanTarget {
            track,
            position_ms,
            playing: true,
        }
    }

    /// §8.2 场景：next → next → seek(30s) → pause，中途无 Commit。
    /// 最终为第二个目标曲目 30s 的暂停计划，不短暂播放两个被取代的目标。
    #[test]
    fn next_next_seek_pause_without_commit_merges_to_final_target() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 10_000));
        let now = 0;

        let out = room
            .submit(now, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        let plan_b = match out {
            Outcome::Preparing { plan } => plan,
            other => panic!("next#1 should be preparing, got {other:?}"),
        };
        let out = room
            .submit(now, key(2), None, Command::Next { to: TRACK_C })
            .unwrap();
        let plan_c = match out {
            Outcome::Preparing { plan } => plan,
            other => panic!("next#2 should be preparing, got {other:?}"),
        };
        // next#1 被取代，next#2 从其目标（第二首）继续累计。
        assert_eq!(
            room.poll(now, key(1)).unwrap(),
            Outcome::Superseded { by: plan_c }
        );
        assert_eq!(
            room.preparing().map(|p| p.target),
            Some(playing(TRACK_C, 0)),
            "连续 next 按计划游标累计"
        );

        let out = room
            .submit(
                now,
                key(3),
                None,
                Command::Seek {
                    track: TRACK_C,
                    position_ms: 30_000,
                },
            )
            .unwrap();
        assert_eq!(
            out,
            Outcome::Preparing {
                plan: PlanId(plan_c.0 + 1)
            }
        );
        assert_eq!(
            room.poll(now, key(2)).unwrap(),
            Outcome::Superseded {
                by: PlanId(plan_c.0 + 1)
            }
        );

        let out = room.submit(now, key(4), None, Command::Pause).unwrap();
        assert_eq!(
            out,
            Outcome::Preparing {
                plan: PlanId(plan_c.0 + 2)
            }
        );

        // 最终：TRACK_C @30s 暂停；呈现事实从未动过。
        assert_eq!(
            room.pending_target(),
            PlanTarget {
                track: TRACK_C,
                position_ms: 30_000,
                playing: false,
            }
        );
        assert_eq!(room.presentation(), playing(TRACK_A, 10_000));
        assert_ne!(plan_b, plan_c);
    }

    /// pause 保留当前目标，取消尚未发布的继续播放意图。
    #[test]
    fn pause_cancels_unpublished_play_intent() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        room.submit(0, key(1), None, Command::Play).unwrap();
        let out = room.submit(0, key(2), None, Command::Pause).unwrap();
        assert!(matches!(out, Outcome::Preparing { .. }));
        assert_eq!(
            room.poll(0, key(1)).unwrap(),
            Outcome::Superseded {
                by: room.preparing().unwrap().id
            }
        );
        assert_eq!(room.pending_target(), stopped(TRACK_A));
    }

    /// 同键同内容重试返回已存结果，不重复执行；同键不同内容冲突。
    #[test]
    fn same_key_retry_does_not_execute_twice() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        room.submit(0, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        let revision_after_first = room.revision();

        let retried = room
            .submit(5 * MS, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        assert_eq!(
            retried,
            Outcome::Preparing {
                plan: room.preparing().unwrap().id
            }
        );
        assert_eq!(room.revision(), revision_after_first, "重试不推进 revision");

        assert_eq!(
            room.submit(5 * MS, key(1), None, Command::Next { to: TRACK_C })
                .unwrap_err()
                .code(),
            "operation_key_conflict"
        );
    }

    /// 乱序低序号与过期操作键：明确拒绝，不当作新操作执行。
    #[test]
    fn stale_and_expired_keys_are_rejected() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        room.submit(0, key(5), None, Command::Pause).unwrap();
        assert_eq!(
            room.submit(0, key(4), None, Command::Pause)
                .unwrap_err()
                .code(),
            "operation_unknown"
        );
        // 已淘汰（TTL 过期）的高水位键重试同样拒绝。
        let later = 11 * 60 * 1_000_000_000;
        assert_eq!(
            room.submit(later, key(5), None, Command::Pause)
                .unwrap_err()
                .code(),
            "operation_unknown"
        );
        assert_eq!(
            room.poll(later, key(5)).unwrap_err().code(),
            "operation_unknown"
        );
        // 新序号照常受理。
        assert!(room.submit(later, key(6), None, Command::Pause).is_ok());
    }

    /// revision 冲突按 §8.2 第 1 条拒绝。
    #[test]
    fn revision_conflict_rejected() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        let stale = room.revision();
        room.submit(0, key(1), None, Command::Pause).unwrap();
        assert_eq!(
            room.submit(0, key(2), Some(stale), Command::Pause)
                .unwrap_err()
                .code(),
            "revision_conflict"
        );
        assert!(room
            .submit(0, key(2), Some(room.revision()), Command::Pause)
            .is_ok());
    }

    /// 一个未生效已发布计划 + 一个准备中意图占满后，第三条命令 busy。
    #[test]
    fn busy_when_published_and_preparing_slots_are_full() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        room.submit(0, key(1), None, Command::Play).unwrap();
        room.report_ready(EndpointId(1), room.preparing().unwrap().id);
        room.commit(0, 500 * MS, 100 * MS).unwrap();
        // 已发布未生效 + 新的准备中意图 → 满载。
        room.submit(0, key(2), None, Command::Pause).unwrap();
        assert_eq!(
            room.submit(0, key(3), None, Command::Pause)
                .unwrap_err()
                .code(),
            "room_busy"
        );
        // 生效并提交后腾出发布槽。
        room.advance(600 * MS);
        assert_eq!(room.presentation(), playing(TRACK_A, 0));
        room.commit(600 * MS, 1100 * MS, 100 * MS).unwrap();
    }

    /// 初次起播：无 Ready 端不发布；已被取代计划的 Ready 不得计数/复活。
    #[test]
    fn initial_start_requires_a_ready_endpoint() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        room.submit(0, key(1), None, Command::Play).unwrap();
        assert_eq!(
            room.commit(0, 500 * MS, 100 * MS).unwrap_err().code(),
            "no_ready_endpoint"
        );
        let stale_plan = room.preparing().unwrap().id;
        // 取代旧意图，让 stale_plan 成为已死计划。
        room.submit(0, key(2), None, Command::Stop).unwrap();
        assert!(!room.report_ready(EndpointId(1), stale_plan));
        // Silence is safe to publish without an output, but does not waive the
        // Ready requirement for the first subsequent audible start.
        room.commit(0, 500 * MS, 100 * MS).unwrap();
        room.advance(500 * MS);
        room.submit(500 * MS, key(3), None, Command::Play).unwrap();
        assert_eq!(
            room.commit(500 * MS, 1000 * MS, 100 * MS)
                .unwrap_err()
                .code(),
            "no_ready_endpoint"
        );
        let current = room.preparing().unwrap().id;
        assert!(room.report_ready(EndpointId(1), current));
        room.commit(500 * MS, 1000 * MS, 100 * MS).unwrap();
    }

    /// 生效期限必须覆盖最小提前量。
    #[test]
    fn effective_at_must_cover_minimum_lead() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        room.submit(0, key(1), None, Command::Play).unwrap();
        room.report_ready(EndpointId(1), room.preparing().unwrap().id);
        assert_eq!(
            room.commit(0, 50 * MS, 100 * MS).unwrap_err().code(),
            "effective_too_soon"
        );
        room.commit(0, 100 * MS, 100 * MS).unwrap();
    }

    /// Commit 后前缀冻结：创建操作不再 superseded；呈现事实等到生效点才提交，
    /// 且每个计划恰好提交一次。
    #[test]
    fn commit_freezes_prefix_and_applies_exactly_once() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        room.submit(0, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        let plan = room.preparing().unwrap().id;
        room.report_ready(EndpointId(1), plan);
        room.commit(0, 400 * MS, 100 * MS).unwrap();

        // 未到生效点：呈现事实不变（提前渲染不提前改歌名）。
        room.advance(399 * MS);
        assert_eq!(room.presentation(), playing(TRACK_A, 0));

        // Commit 后的新意图不能取代已发布计划。
        let out = room.submit(350 * MS, key(2), None, Command::Pause).unwrap();
        assert!(matches!(out, Outcome::Preparing { .. }));
        assert_eq!(
            room.poll(350 * MS, key(1)).unwrap(),
            Outcome::Scheduled {
                plan,
                effective_at: 400 * MS
            }
        );

        // 新意图从已发布计划的目标出发，且不会把它改写成 superseded。
        assert_eq!(
            room.preparing().map(|p| p.target),
            Some(PlanTarget {
                track: TRACK_B,
                position_ms: 0,
                playing: false,
            })
        );

        room.advance(400 * MS);
        assert_eq!(room.presentation(), playing(TRACK_B, 0));
        assert_eq!(
            room.poll(400 * MS, key(1)).unwrap(),
            Outcome::Applied { plan, at: 400 * MS }
        );
        // 重复推进不重复提交。
        room.advance(1000 * MS);
        assert_eq!(
            room.poll(1000 * MS, key(1)).unwrap(),
            Outcome::Applied { plan, at: 400 * MS }
        );
        assert_eq!(room.presentation(), playing(TRACK_B, 0));
    }

    /// seek 绑定实例：队列已前进后，指向旧实例的 seek 明确失败。
    #[test]
    fn seek_to_stale_instance_fails() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        room.submit(0, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        assert_eq!(
            room.submit(
                0,
                key(2),
                None,
                Command::Seek {
                    track: TRACK_A,
                    position_ms: 5_000,
                }
            )
            .unwrap(),
            Outcome::Failed {
                reason: PlanFailure::StaleTrackInstance
            }
        );
    }

    /// 不改变目标的命令是 no_op，不推进 revision、不占准备槽。
    #[test]
    fn no_op_when_command_changes_nothing() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        let before = room.revision();
        assert_eq!(
            room.submit(0, key(1), None, Command::Pause).unwrap(),
            Outcome::NoOp
        );
        assert_eq!(room.revision(), before);
        assert!(room.preparing().is_none());
    }

    /// 停止清除可恢复播放位置；恢复是新的代际与计划。
    #[test]
    fn stop_clears_position() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 90_000));
        room.submit(0, key(1), None, Command::Stop).unwrap();
        assert_eq!(room.pending_target(), stopped(TRACK_A));
        room.report_ready(EndpointId(1), room.preparing().unwrap().id);
        room.commit(0, 300 * MS, 100 * MS).unwrap();
        room.advance(300 * MS);
        assert_eq!(room.presentation(), stopped(TRACK_A));

        // 停止后再起播是新的代际；has_started 后的提交不再强制 Ready 门禁
        // （初次起播门禁由前一条测试单独覆盖）。
        room.submit(300 * MS, key(2), None, Command::Play).unwrap();
        assert!(room.commit(300 * MS, 800 * MS, 100 * MS).is_ok());
    }

    /// 容量淘汰：第 257 条操作挤掉最旧记录。
    #[test]
    fn outcome_capacity_evicts_oldest() {
        let mut room = PlanScheduler::new(stopped(TRACK_A));
        for seq in 1..=256 {
            room.submit(seq * MS, key(seq), None, Command::Pause)
                .unwrap();
        }
        assert!(room.poll(256 * MS, key(1)).is_ok());
        room.submit(257 * MS, key(257), None, Command::Pause)
            .unwrap();
        assert_eq!(
            room.poll(257 * MS, key(1)).unwrap_err().code(),
            "operation_unknown"
        );
        assert!(room.poll(257 * MS, key(2)).is_ok());
    }

    /// 每个用户控制计划换新代际（暂停/停止/seek/强制切歌/恢复用代际切换）。
    #[test]
    fn user_control_plans_get_fresh_epochs() {
        let mut room = PlanScheduler::new(playing(TRACK_A, 0));
        let first = room.epoch();
        room.submit(0, key(1), None, Command::Next { to: TRACK_B })
            .unwrap();
        let second = room.preparing().unwrap().epoch;
        assert_ne!(first, second, "强制切歌换代际");
        room.submit(0, key(2), None, Command::Pause).unwrap();
        let third = room.preparing().unwrap().epoch;
        assert_ne!(second, third, "暂停换代际");
        assert_eq!(room.pending_target().track, TRACK_B);
    }
}
