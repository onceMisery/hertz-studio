// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 接收端音频门禁：最小协议状态机的接收侧（lan-listening §8.1/§12.3）。
//!
//! 语义：新代际只有在「Format+Plan 匹配 + 收到未过设备提交期限的 Commit +
//! 到达 `effective_at`」之后才送往声卡；迟到的 Commit 不触发追播；旧会话
//! 的确认不得复活；已有未生效 Commit 时后续准备代际只保留意图、其 PCM
//! 丢弃；过期代际与过时块明确丢弃。播放由呈现时间（Plan 锚点）驱动，不
//! 由网络收包时间推导；到期无帧时输出受控静音（欠载计数），不重播、不追赶。
//!
//! 与 [`super::PlanScheduler`] 同为 P0 冻结件：时间注入、只记元数据不存
//! 样本、无线程/网络/音频依赖。§12.3 的反例（乱序、迟到、旧会话、第三代、
//! 非法序号/重叠帧）以确定性用例钉住。

use super::Nanos;

/// PCM 丢弃原因。块合法性（序号单调、帧连续、非零块）在实时回调之外检查。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscardReason {
    SessionMismatch,
    /// 已被换代弃用的代际。
    StaleEpoch,
    /// 到达时已全部越过呈现期限的块。
    PastDeadline,
    /// 等 Format/Plan 匹配超时。
    UnmatchedTimeout,
    /// 等 Match 窗口溢出，丢最旧。
    UnmatchedOverflow,
    /// 已有未生效 Commit 时的第三代及以后代际。
    ThirdGeneration,
    /// 序号回退、帧不连续或零长块。
    InvalidBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitIgnoreReason {
    SessionMismatch,
    NotPreparing,
    /// Format+Plan 尚未齐备，或尚未对该计划 Ready。
    NotReady,
    /// Commit 携带的计划 ID 与准备中计划不符：改锚点/边界必须换计划 ID
    /// 并重新 Ready，不能在 Commit 里偷偷改期。
    PlanMismatch,
    /// 到达时已过设备提交期限（effective_at − device_lead < now）。
    LatePastDeadline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatDesc {
    pub format_id: u32,
    pub sample_rate: u32,
    pub channels: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanDesc {
    pub epoch: u64,
    pub plan_id: u64,
    /// 帧 0 的呈现时间（房间单调钟，接收端已换算到本机域）。
    pub anchor_ns: Nanos,
    /// 晚加入从指定帧出声（不从 0 重播）。
    pub join_frame: u64,
}

/// 门禁输入。两条 WSS 没有到达顺序保证，顺序由测试注入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateInput {
    /// 握手后的会话绑定；替换旧会话，旧代际全部作废。
    Rebind {
        session: u64,
    },
    /// 控制或音频连接断开：会话失效，当前缓冲排干即停。
    Disconnect,
    Format {
        session: u64,
        epoch: u64,
        format: FormatDesc,
    },
    Plan {
        session: u64,
        plan: PlanDesc,
    },
    Pcm {
        session: u64,
        epoch: u64,
        sequence: u64,
        frame_index: u64,
        frame_count: u32,
    },
    Commit {
        session: u64,
        epoch: u64,
        plan_id: u64,
        effective_at: Nanos,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateAction {
    /// 准备中代际的 Format+Plan 齐备，对该计划发 Ready（每计划恰好一次）。
    Ready {
        epoch: u64,
        plan_id: u64,
    },
    /// 已提交代际按呈现时间送声卡的帧数。
    Play {
        epoch: u64,
        frames: u32,
    },
    /// 到期但缓冲不足的帧数：受控静音，不重播、不追赶。
    Underrun {
        epoch: u64,
        frames: u32,
    },
    /// 未生效 Commit 到期，切换到新代际（从 join_frame 起）。
    EpochSwitch {
        from: Option<u64>,
        to: u64,
        at: Nanos,
    },
    DiscardPcm {
        epoch: u64,
        reason: DiscardReason,
    },
    CommitIgnored {
        reason: CommitIgnoreReason,
    },
    /// 丢弃/断线后的重同步目标：当前已提交代际，或无计划时的全静音。
    Resync {
        to: Option<u64>,
    },
}

#[derive(Clone, Copy)]
struct Unmatched {
    epoch: u64,
    sequence: u64,
    frame_index: u64,
    frame_count: u32,
    arrived_ns: Nanos,
}

/// 一个代际的 PCM 记账：帧连续性期望 + 已缓冲帧数。
struct EpochBuffer {
    /// 下一块应从该帧开始（过时块被丢弃时同样推进它）。
    expected_next: u64,
    buffered_frames: u32,
    seq_high: Option<u64>,
    /// 已呈现范围的右开边界，包含欠载静音；独立于收包连续性。
    presented_until: u64,
}

impl EpochBuffer {
    fn from_join(join_frame: u64) -> Self {
        Self {
            expected_next: join_frame,
            buffered_frames: 0,
            seq_high: None,
            presented_until: join_frame,
        }
    }

    /// 帧连续性校验并入账。返回 Ok(true)=已缓冲，Ok(false)=整块已过呈现
    /// 期限（按期限丢弃，不占缓冲但推进连续性期望）。
    fn accept(
        &mut self,
        sequence: u64,
        frame_index: u64,
        frame_count: u32,
        due_until: Option<u64>,
    ) -> Result<bool, DiscardReason> {
        if frame_count == 0 {
            return Err(DiscardReason::InvalidBlock);
        }
        if self.seq_high.is_some_and(|high| sequence <= high) {
            return Err(DiscardReason::InvalidBlock);
        }
        if self.seq_high.is_some() && frame_index != self.expected_next {
            return Err(DiscardReason::InvalidBlock);
        }
        if frame_index < self.expected_next {
            return Err(DiscardReason::InvalidBlock);
        }
        let end = frame_index
            .checked_add(u64::from(frame_count))
            .ok_or(DiscardReason::InvalidBlock)?;
        let cutoff = due_until.unwrap_or(0).max(self.presented_until);
        // 丢掉已经过去的前缀，包括尚未出队的旧缓冲；不把晚到样本追播。
        let retained =
            u64::from(self.buffered_frames).min(self.expected_next.saturating_sub(cutoff));
        let new_frames = end.saturating_sub(frame_index.max(cutoff));
        let total =
            u32::try_from(retained + new_frames).map_err(|_| DiscardReason::InvalidBlock)?;
        self.seq_high = Some(sequence);
        self.expected_next = end;
        self.buffered_frames = total;
        if new_frames == 0 {
            return Ok(false);
        }
        Ok(true)
    }

    /// 下一帧应呈现的帧号（剩余缓冲的起点）。
    fn cursor(&self) -> u64 {
        self.expected_next - u64::from(self.buffered_frames)
    }

    fn consume(&mut self, frames: u32) {
        self.buffered_frames = self.buffered_frames.saturating_sub(frames);
    }
}

struct Preparing {
    epoch: u64,
    format: Option<FormatDesc>,
    plan: Option<PlanDesc>,
    buffer: EpochBuffer,
    ready_sent: bool,
    /// Commit 的生效时刻；Some 后该代际等待 EpochSwitch。
    commit: Option<Nanos>,
}

impl Preparing {
    fn new(epoch: u64) -> Self {
        Self {
            epoch,
            format: None,
            plan: None,
            buffer: EpochBuffer::from_join(0),
            ready_sent: false,
            commit: None,
        }
    }

    fn complete(&self) -> bool {
        self.format
            .is_some_and(|f| f.sample_rate > 0 && f.channels > 0)
            && self.plan.is_some()
    }
}

/// 接收端音频门禁。确定性：同输入同输出。
pub struct ReceiverGate {
    session: u64,
    /// 保留采样率，用有理数换算期限，避免截断单帧纳秒带来的累计漂移。
    sample_rate: u32,
    /// (epoch, plan_id, anchor, buffer)。
    current: Option<(u64, u64, Nanos, EpochBuffer)>,
    preparing: Option<Preparing>,
    /// 已有未生效 Commit 时的后续准备代际（只保留意图，其 PCM 丢弃）。
    intent: Option<Preparing>,
    unmatched: Vec<Unmatched>,
    unmatched_frames: u32,
    device_lead_ns: Nanos,
    match_timeout_ns: Nanos,
    unmatched_bound: u32,
}

impl ReceiverGate {
    /// `device_lead_ns`：设备提交提前量（Commit 必须在 effective_at − lead
    /// 之前到达）；`match_timeout_ns`：先到 PCM 等 Format/Plan 的时限；
    /// `unmatched_bound`：等匹配窗口的帧数上限。
    pub fn new(device_lead_ns: Nanos, match_timeout_ns: Nanos, unmatched_bound: u32) -> Self {
        Self {
            session: 0,
            sample_rate: 0,
            current: None,
            preparing: None,
            intent: None,
            unmatched: Vec::new(),
            unmatched_frames: 0,
            device_lead_ns,
            match_timeout_ns,
            unmatched_bound,
        }
    }

    pub fn current_epoch(&self) -> Option<u64> {
        self.current.as_ref().map(|(epoch, _, _, _)| *epoch)
    }

    pub fn preparing_epoch(&self) -> Option<u64> {
        self.preparing.as_ref().map(|p| p.epoch)
    }

    /// 当前已过呈现期限的帧号（不含，即 T_present(f) ≤ now 的 f 上界+1）。
    fn due_until(&self, now: Nanos) -> Option<u64> {
        let (_, _, anchor, _) = self.current.as_ref()?;
        if now < *anchor {
            return Some(0);
        }
        let due = u128::from(now - anchor) * u128::from(self.sample_rate) / 1_000_000_000 + 1;
        Some(due.min(u128::from(u64::MAX)) as u64)
    }

    pub fn input(&mut self, now: Nanos, event: GateInput) -> Vec<GateAction> {
        match event {
            GateInput::Rebind { session } => {
                // 会话重建：一切旧代际作废，先全静音等待新计划。
                self.session = session;
                self.current = None;
                self.preparing = None;
                self.intent = None;
                self.unmatched.clear();
                self.unmatched_frames = 0;
                self.sample_rate = 0;
                vec![GateAction::Resync { to: None }]
            }
            GateInput::Disconnect => {
                self.session = 0;
                self.preparing = None;
                self.intent = None;
                self.unmatched.clear();
                self.unmatched_frames = 0;
                Vec::new()
            }
            GateInput::Format {
                session,
                epoch,
                format,
            } => {
                if session != self.session {
                    return Vec::new();
                }
                self.set_preparing_slot(epoch, |p| {
                    if p.format != Some(format) {
                        p.format = Some(format);
                        p.ready_sent = false;
                    }
                });
                self.complete_ready(now, epoch)
            }
            GateInput::Plan { session, plan } => {
                if session != self.session {
                    return Vec::new();
                }
                let epoch = plan.epoch;
                self.set_preparing_slot(epoch, |p| {
                    if p.plan != Some(plan) {
                        p.plan = Some(plan);
                        p.ready_sent = false;
                        if p.buffer.seq_high.is_none() {
                            p.buffer = EpochBuffer::from_join(plan.join_frame);
                        }
                    }
                });
                self.complete_ready(now, epoch)
            }
            GateInput::Pcm {
                session,
                epoch,
                sequence,
                frame_index,
                frame_count,
            } => self.input_pcm(now, session, epoch, sequence, frame_index, frame_count),
            GateInput::Commit {
                session,
                epoch,
                plan_id,
                effective_at,
            } => self.input_commit(now, session, epoch, plan_id, effective_at),
        }
    }

    /// Format/Plan 落位：同代际补槽；准备槽空或未提交时开新槽（未提交的
    /// 旧准备被新代际取代）；已有未生效 Commit 时进意图槽。
    fn set_preparing_slot(&mut self, epoch: u64, fill: impl FnOnce(&mut Preparing)) {
        // 已发布计划的描述不可改写；相同重发无需重新 Ready。
        if self
            .preparing
            .as_ref()
            .is_some_and(|p| p.epoch == epoch && p.commit.is_some())
        {
            return;
        }
        if self.current_epoch().is_some_and(|current| epoch <= current) {
            return;
        }
        let target = if self.preparing.as_ref().is_some_and(|p| p.epoch == epoch) {
            &mut self.preparing
        } else if self.preparing.as_ref().is_some_and(|p| p.commit.is_none()) {
            // 无提交挂起：新代际直接取代旧准备（未被 Ready 的计划随之作废）。
            self.intent = None;
            self.preparing = Some(Preparing::new(epoch));
            &mut self.preparing
        } else if self.intent.as_ref().is_some_and(|i| i.epoch == epoch) {
            &mut self.intent
        } else if self.preparing.is_some() {
            // 已有未生效 Commit：第三代只保留意图。
            self.intent = Some(Preparing::new(epoch));
            &mut self.intent
        } else {
            self.preparing = Some(Preparing::new(epoch));
            &mut self.preparing
        };
        if let Some(slot) = target.as_mut() {
            fill(slot);
        }
    }

    /// Format+Plan 齐备且未发过 Ready：对准备中计划恰好发一次。意图代际
    /// （已有未生效 Commit）不 Ready，晋升后才发。
    fn complete_ready(&mut self, now: Nanos, epoch: u64) -> Vec<GateAction> {
        let mut actions = Vec::new();
        let resync_to = self.current_epoch();
        if let Some(p) = &mut self.preparing {
            if p.epoch == epoch && p.complete() && !p.ready_sent {
                // 匹配完成即离开 unmatched：不能等到起播时再按匹配超时丢掉。
                // 保留原序号，并逐块报告校验失败，避免损坏后续收包水位。
                let mut keep = Vec::new();
                let mut timed_out = false;
                for block in std::mem::take(&mut self.unmatched) {
                    if block.epoch != epoch {
                        keep.push(block);
                        continue;
                    }
                    let result = if now.saturating_sub(block.arrived_ns) > self.match_timeout_ns {
                        timed_out = true;
                        Err(DiscardReason::UnmatchedTimeout)
                    } else {
                        p.buffer
                            .accept(block.sequence, block.frame_index, block.frame_count, None)
                    };
                    match result {
                        Ok(true) => {}
                        Ok(false) => actions.push(GateAction::DiscardPcm {
                            epoch,
                            reason: DiscardReason::PastDeadline,
                        }),
                        Err(reason) => actions.push(GateAction::DiscardPcm { epoch, reason }),
                    }
                }
                self.unmatched = keep;
                self.unmatched_frames = self.unmatched.iter().map(|u| u.frame_count).sum();
                if timed_out {
                    actions.push(GateAction::Resync { to: resync_to });
                }
                p.ready_sent = true;
                actions.push(GateAction::Ready {
                    epoch,
                    plan_id: p.plan.unwrap().plan_id,
                });
            }
        }
        actions
    }

    fn input_pcm(
        &mut self,
        now: Nanos,
        session: u64,
        epoch: u64,
        sequence: u64,
        frame_index: u64,
        frame_count: u32,
    ) -> Vec<GateAction> {
        if session != self.session {
            return vec![GateAction::DiscardPcm {
                epoch,
                reason: DiscardReason::SessionMismatch,
            }];
        }
        let due = self.due_until(now);
        // 当前已提交代际。
        if let Some((current_epoch, _, _, buffer)) = &mut self.current {
            if *current_epoch == epoch {
                return match buffer.accept(sequence, frame_index, frame_count, due) {
                    Ok(true) => Vec::new(),
                    Ok(false) => vec![GateAction::DiscardPcm {
                        epoch,
                        reason: DiscardReason::PastDeadline,
                    }],
                    Err(reason) => vec![GateAction::DiscardPcm { epoch, reason }],
                };
            }
        }
        // 准备中代际（含已收 Commit、等生效的未来帧）。
        if let Some(p) = &mut self.preparing {
            if p.epoch == epoch && p.complete() {
                return match p.buffer.accept(sequence, frame_index, frame_count, None) {
                    Ok(_) => Vec::new(),
                    Err(reason) => vec![GateAction::DiscardPcm { epoch, reason }],
                };
            }
        }
        // 意图代际：已有未生效 Commit，不收第三代 PCM。
        if self.intent.as_ref().is_some_and(|i| i.epoch == epoch) {
            return vec![GateAction::DiscardPcm {
                epoch,
                reason: DiscardReason::ThirdGeneration,
            }];
        }
        // 过期代际：早于任何已知代际。
        let max_known = [
            self.current_epoch(),
            self.preparing.as_ref().map(|p| p.epoch),
            self.intent.as_ref().map(|p| p.epoch),
        ]
        .into_iter()
        .flatten()
        .max();
        if max_known.is_some_and(|m| epoch < m) {
            return vec![GateAction::DiscardPcm {
                epoch,
                reason: DiscardReason::StaleEpoch,
            }];
        }
        // 未来代际，先到：有界暂存等 Format/Plan。
        self.unmatched.push(Unmatched {
            epoch,
            sequence,
            frame_index,
            frame_count,
            arrived_ns: now,
        });
        self.unmatched_frames += frame_count;
        let mut actions = Vec::new();
        while self.unmatched_frames > self.unmatched_bound {
            let Some(oldest) = self.unmatched.first().copied() else {
                break;
            };
            self.unmatched.remove(0);
            self.unmatched_frames -= oldest.frame_count;
            actions.push(GateAction::DiscardPcm {
                epoch: oldest.epoch,
                reason: DiscardReason::UnmatchedOverflow,
            });
        }
        actions
    }

    fn input_commit(
        &mut self,
        now: Nanos,
        session: u64,
        epoch: u64,
        plan_id: u64,
        effective_at: Nanos,
    ) -> Vec<GateAction> {
        if session != self.session {
            return vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::SessionMismatch,
            }];
        }
        let Some(p) = &mut self.preparing else {
            return vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::NotPreparing,
            }];
        };
        if p.epoch != epoch || !p.plan.is_some_and(|plan| plan.plan_id == plan_id) {
            return vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::PlanMismatch,
            }];
        }
        if !p.complete() || !p.ready_sent {
            return vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::NotReady,
            }];
        }
        if let Some(committed_at) = p.commit {
            // 同一 Commit 幂等；重复消息不能改写已发布的生效边界。
            return if committed_at == effective_at {
                Vec::new()
            } else {
                vec![GateAction::CommitIgnored {
                    reason: CommitIgnoreReason::PlanMismatch,
                }]
            };
        }
        // 声卡提交期限：必须在 effective_at − device_lead 之前收到。
        if now.saturating_add(self.device_lead_ns) > effective_at {
            let to = self.current_epoch();
            return vec![
                GateAction::CommitIgnored {
                    reason: CommitIgnoreReason::LatePastDeadline,
                },
                // 不追播：新代际静音重同步，当前代际照常。
                GateAction::Resync { to },
            ];
        }
        p.commit = Some(effective_at);
        Vec::new()
    }

    /// 推进到 `now`：过期未匹配丢弃、生效切换、按呈现时间出帧。
    pub fn advance(&mut self, now: Nanos) -> Vec<GateAction> {
        let mut actions = Vec::new();
        // 1) 等 Format/Plan 超时的 PCM：逐块丢弃并重同步到当前计划。
        let mut keep = Vec::new();
        let mut timed_out = Vec::new();
        for block in std::mem::take(&mut self.unmatched) {
            if now.saturating_sub(block.arrived_ns) > self.match_timeout_ns {
                timed_out.push(block);
            } else {
                keep.push(block);
            }
        }
        self.unmatched = keep;
        self.unmatched_frames = self.unmatched.iter().map(|u| u.frame_count).sum();
        if !timed_out.is_empty() {
            for block in timed_out {
                actions.push(GateAction::DiscardPcm {
                    epoch: block.epoch,
                    reason: DiscardReason::UnmatchedTimeout,
                });
            }
            actions.push(GateAction::Resync {
                to: self.current_epoch(),
            });
        }
        // 2) 未生效 Commit 到期 → 切换代际。
        let switch = self
            .preparing
            .as_ref()
            .and_then(|p| p.commit)
            .is_some_and(|effective_at| now >= effective_at);
        if switch {
            let p = self.preparing.take().unwrap();
            let plan = p.plan.unwrap();
            let format = p.format.unwrap();
            let actions_switch = GateAction::EpochSwitch {
                from: self.current_epoch(),
                to: p.epoch,
                at: p.commit.unwrap(),
            };
            self.sample_rate = format.sample_rate;
            self.current = Some((p.epoch, plan.plan_id, plan.anchor_ns, p.buffer));
            actions.push(actions_switch);
            // 意图代际晋升为准备代际；齐备则补发 Ready。
            if let Some(intent) = self.intent.take() {
                let epoch = intent.epoch;
                self.preparing = Some(intent);
                actions.extend(self.complete_ready(now, epoch));
            }
            // 同拍继续按呈现时间出帧（新代际可能已有到期帧）。
        }
        // 3) 按呈现时间出帧：到期帧送声卡，缺口记欠载（受控静音）。
        let due_now = self.due_until(now);
        if let Some((epoch, _, _, buffer)) = &mut self.current {
            if let Some(due_until) = due_now {
                let cursor = buffer.presented_until;
                let data_start = buffer.cursor().max(cursor);
                let data_end = buffer.expected_next;
                let gap_end = due_until.min(data_start).max(cursor);
                let play_end = due_until.min(data_end).max(gap_end);
                // 首块可能从未来帧开始：先静音缺口，再播放已有帧，最后静音尾部。
                for (play, mut frames) in [
                    (false, gap_end - cursor),
                    (true, play_end - gap_end),
                    (false, due_until.saturating_sub(play_end)),
                ] {
                    while frames > 0 {
                        let count = frames.min(u64::from(u32::MAX)) as u32;
                        actions.push(if play {
                            buffer.consume(count);
                            GateAction::Play {
                                epoch: *epoch,
                                frames: count,
                            }
                        } else {
                            GateAction::Underrun {
                                epoch: *epoch,
                                frames: count,
                            }
                        });
                        frames -= u64::from(count);
                    }
                }
                buffer.presented_until = cursor.max(due_until);
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Nanos = 1_000_000;
    const LEAD: Nanos = 100 * MS;
    const TIMEOUT: Nanos = 500 * MS;

    fn gate() -> ReceiverGate {
        let mut gate = ReceiverGate::new(LEAD, TIMEOUT, 1_000);
        gate.input(0, GateInput::Rebind { session: 7 });
        gate
    }

    /// 采样率 1000Hz：1 帧 = 1ms，呈现算术直观。
    fn format(epoch: u64) -> GateInput {
        GateInput::Format {
            session: 7,
            epoch,
            format: FormatDesc {
                format_id: 1,
                sample_rate: 1000,
                channels: 2,
            },
        }
    }

    fn plan(epoch: u64, plan_id: u64, anchor_ns: Nanos, join_frame: u64) -> GateInput {
        GateInput::Plan {
            session: 7,
            plan: PlanDesc {
                epoch,
                plan_id,
                anchor_ns,
                join_frame,
            },
        }
    }

    fn pcm(epoch: u64, sequence: u64, frame_index: u64, frame_count: u32) -> GateInput {
        GateInput::Pcm {
            session: 7,
            epoch,
            sequence,
            frame_index,
            frame_count,
        }
    }

    fn commit(epoch: u64, plan_id: u64, effective_at: Nanos) -> GateInput {
        GateInput::Commit {
            session: 7,
            epoch,
            plan_id,
            effective_at,
        }
    }

    /// 建立一个正在出声的当前代际（epoch 1，anchor 0）。
    fn playing(gate: &mut ReceiverGate) {
        gate.input(0, format(1));
        gate.input(0, plan(1, 10, 0, 0));
        gate.input(0, pcm(1, 1, 0, 2_000));
        gate.input(0, commit(1, 10, 100 * MS));
        gate.advance(150 * MS);
        assert_eq!(gate.current_epoch(), Some(1));
    }

    /// PCM 先于 Format/Plan：等匹配、并入、Commit 后按呈现时间出帧。
    #[test]
    fn pcm_before_format_waits_then_plays_after_commit() {
        let mut gate = gate();
        assert!(
            gate.input(0, pcm(2, 1, 0, 100)).is_empty(),
            "先到 PCM 只暂存"
        );
        let actions = [
            gate.input(5 * MS, format(2)),
            gate.input(5 * MS, plan(2, 11, 10 * MS, 0)),
        ]
        .concat();
        assert_eq!(
            actions,
            vec![GateAction::Ready {
                epoch: 2,
                plan_id: 11
            }]
        );
        assert!(gate.input(50 * MS, commit(2, 11, 200 * MS)).is_empty());
        let actions = gate.advance(300 * MS);
        assert!(actions.contains(&GateAction::EpochSwitch {
            from: None,
            to: 2,
            at: 200 * MS
        }));
        // anchor=10ms，300ms 到期帧号 291；并入的 100 帧全部到期。
        assert!(actions.contains(&GateAction::Play {
            epoch: 2,
            frames: 100
        }));
        assert_eq!(gate.current_epoch(), Some(2));
    }

    /// 等 Format/Plan 超时：丢弃并重同步，什么都不出声。
    #[test]
    fn unmatched_pcm_times_out_and_discards() {
        let mut gate = gate();
        assert!(gate.input(0, pcm(9, 1, 0, 50)).is_empty());
        let actions = gate.advance(600 * MS);
        assert!(actions.contains(&GateAction::DiscardPcm {
            epoch: 9,
            reason: DiscardReason::UnmatchedTimeout
        }));
        assert!(actions.contains(&GateAction::Resync { to: None }));
        assert!(!actions.iter().any(|a| matches!(a, GateAction::Play { .. })));
    }

    /// 未收到有效 Commit：新代际永不出声。
    #[test]
    fn no_commit_no_new_epoch_sound() {
        let mut gate = gate();
        gate.input(0, format(2));
        gate.input(0, plan(2, 11, 10 * MS, 0));
        gate.input(0, pcm(2, 1, 0, 100));
        let actions = gate.advance(2_000 * MS);
        assert!(!actions
            .iter()
            .any(|a| matches!(a, GateAction::EpochSwitch { .. })));
        assert!(!actions
            .iter()
            .any(|a| matches!(a, GateAction::Play { epoch: 2, .. })));
    }

    /// Commit 迟到（过设备提交期限）：不追播，新代际静音重同步，当前照常。
    #[test]
    fn late_commit_does_not_catch_up() {
        let mut gate = gate();
        playing(&mut gate);
        // 准备 epoch 2；Commit 在期限之后才到（期限 = 500 − 100 = 400ms）。
        gate.input(400 * MS, format(2));
        gate.input(400 * MS, plan(2, 21, 500 * MS, 0));
        gate.input(400 * MS, pcm(2, 1, 0, 500));
        let actions = gate.input(460 * MS, commit(2, 21, 500 * MS));
        assert!(actions.contains(&GateAction::CommitIgnored {
            reason: CommitIgnoreReason::LatePastDeadline
        }));
        assert!(actions.contains(&GateAction::Resync { to: Some(1) }));
        let later = gate.advance(800 * MS);
        // epoch 2 永不出声；epoch 1 继续按呈现时间出帧。
        assert!(!later
            .iter()
            .any(|a| matches!(a, GateAction::EpochSwitch { to: 2, .. })));
        assert!(later
            .iter()
            .any(|a| matches!(a, GateAction::Play { epoch: 1, .. })));
        assert_eq!(gate.current_epoch(), Some(1));
    }

    /// 断线重绑后，旧会话的 Commit/PCM 不得复活任何东西。
    #[test]
    fn stale_session_is_rejected_after_rebind() {
        let mut gate = gate();
        gate.input(0, format(2));
        gate.input(0, plan(2, 11, 10 * MS, 0));
        gate.input(0, GateInput::Disconnect);
        assert_eq!(
            gate.input(10 * MS, commit(2, 11, 500 * MS)),
            vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::SessionMismatch
            }]
        );
        assert_eq!(
            gate.input(10 * MS, pcm(2, 1, 0, 10)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::SessionMismatch
            }]
        );
        gate.input(10 * MS, GateInput::Rebind { session: 8 });
        assert_eq!(gate.current_epoch(), None);
    }

    /// Commit 计划 ID 不符：明确拒绝（换计划必须重新 Ready，不能改期）。
    #[test]
    fn commit_plan_mismatch_rejected() {
        let mut gate = gate();
        gate.input(0, format(2));
        gate.input(0, plan(2, 11, 10 * MS, 0));
        assert_eq!(
            gate.input(10 * MS, commit(2, 99, 500 * MS)),
            vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::PlanMismatch
            }]
        );
        // 正确计划 ID 仍可提交。
        assert!(gate.input(20 * MS, commit(2, 11, 500 * MS)).is_empty());
    }

    /// 已有未生效 Commit：第三代只保留意图，其 PCM 丢弃；切换后晋升并补发
    /// Ready。
    #[test]
    fn third_generation_is_intent_only_until_switch() {
        let mut gate = gate();
        playing(&mut gate);
        // epoch 2 准备并收到 Commit（未生效）。
        gate.input(300 * MS, format(2));
        gate.input(300 * MS, plan(2, 21, 600 * MS, 0));
        gate.input(300 * MS, pcm(2, 1, 0, 300));
        gate.input(350 * MS, commit(2, 21, 600 * MS));
        // 第三代 epoch 3：Format/Plan 只保留意图（无 Ready）。
        assert!(gate.input(400 * MS, format(3)).is_empty());
        assert!(
            gate.input(400 * MS, plan(3, 31, 1_200 * MS, 0)).is_empty(),
            "意图代际不发 Ready"
        );
        assert_eq!(
            gate.input(410 * MS, pcm(3, 1, 0, 100)),
            vec![GateAction::DiscardPcm {
                epoch: 3,
                reason: DiscardReason::ThirdGeneration
            }]
        );
        // 切换到 epoch 2；epoch 3 晋升为准备代际并补发 Ready。
        let actions = gate.advance(650 * MS);
        assert!(actions.contains(&GateAction::EpochSwitch {
            from: Some(1),
            to: 2,
            at: 600 * MS
        }));
        assert!(actions.contains(&GateAction::Ready {
            epoch: 3,
            plan_id: 31
        }));
        assert_eq!(gate.preparing_epoch(), Some(3));
    }

    /// 切换后旧代际 PCM 明确丢弃。
    #[test]
    fn stale_epoch_pcm_discarded_after_switch() {
        let mut gate = gate();
        playing(&mut gate);
        gate.input(300 * MS, format(2));
        gate.input(300 * MS, plan(2, 21, 600 * MS, 0));
        gate.input(300 * MS, pcm(2, 1, 0, 300));
        gate.input(350 * MS, commit(2, 21, 600 * MS));
        gate.advance(650 * MS);
        assert_eq!(gate.current_epoch(), Some(2));
        assert_eq!(
            gate.input(700 * MS, pcm(1, 9, 500, 10)),
            vec![GateAction::DiscardPcm {
                epoch: 1,
                reason: DiscardReason::StaleEpoch
            }]
        );
    }

    /// 非法序号/重叠帧/零长块明确拒绝。
    #[test]
    fn invalid_blocks_are_rejected() {
        let mut gate = gate();
        gate.input(0, format(2));
        gate.input(0, plan(2, 11, 10 * MS, 0));
        gate.input(0, pcm(2, 5, 0, 100));
        // 序号回退。
        assert_eq!(
            gate.input(1, pcm(2, 5, 100, 100)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::InvalidBlock
            }]
        );
        // 帧不连续（重叠/跳帧）。
        assert_eq!(
            gate.input(1, pcm(2, 6, 150, 100)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::InvalidBlock
            }]
        );
        // 零长块。
        assert_eq!(
            gate.input(1, pcm(2, 7, 100, 0)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::InvalidBlock
            }]
        );
        // 连续块照常接收。
        assert!(gate.input(1, pcm(2, 8, 100, 100)).is_empty());
    }

    /// 到期无帧：受控静音（欠载计数），不重播、不追赶；过期块按期限丢弃。
    #[test]
    fn underrun_counts_starved_frames() {
        let mut gate = gate();
        gate.input(0, format(2));
        gate.input(0, plan(2, 11, 0, 0));
        gate.input(0, pcm(2, 1, 0, 100));
        gate.input(0, commit(2, 11, 100 * MS));
        let actions = gate.advance(500 * MS);
        assert!(actions.contains(&GateAction::Play {
            epoch: 2,
            frames: 100
        }));
        // anchor=0：到期帧号 501，缓冲 100 → 欠载 401。
        assert!(actions.contains(&GateAction::Underrun {
            epoch: 2,
            frames: 401
        }));
        // 之后补到的帧若已全过期限，同样按期限丢弃；丢弃推进连续性期望，
        // 后续块不会被判为 InvalidBlock（链条没断）。
        assert_eq!(
            gate.input(500 * MS, pcm(2, 2, 100, 100)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::PastDeadline
            }]
        );
        assert_eq!(
            gate.input(500 * MS, pcm(2, 3, 200, 100)),
            vec![GateAction::DiscardPcm {
                epoch: 2,
                reason: DiscardReason::PastDeadline
            }]
        );
    }

    /// 等匹配窗口溢出：丢最旧，保留最新。
    #[test]
    fn unmatched_overflow_drops_oldest() {
        let mut gate = ReceiverGate::new(LEAD, TIMEOUT, 100);
        gate.input(0, GateInput::Rebind { session: 7 });
        assert!(gate.input(0, pcm(9, 1, 0, 60)).is_empty());
        let actions = gate.input(1, pcm(9, 2, 60, 60));
        assert_eq!(
            actions,
            vec![GateAction::DiscardPcm {
                epoch: 9,
                reason: DiscardReason::UnmatchedOverflow
            }]
        );
    }

    fn prepared(rate: u32) -> ReceiverGate {
        let mut gate = gate();
        gate.input(
            0,
            GateInput::Format {
                session: 7,
                epoch: 1,
                format: FormatDesc {
                    format_id: 1,
                    sample_rate: rate,
                    channels: 2,
                },
            },
        );
        gate.input(0, plan(1, 10, 1_000 * MS, 0));
        gate
    }

    fn played(actions: &[GateAction]) -> u64 {
        actions
            .iter()
            .map(|a| match a {
                GateAction::Play { frames, .. } => u64::from(*frames),
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn early_blocks_keep_sequences_and_merge_before_live_pcm() {
        // 三种交错：两个描述均未到、只到 Format、只到 Plan。
        for prefix in 0..3 {
            let mut gate = gate();
            if prefix == 1 {
                gate.input(0, format(1));
            }
            if prefix == 2 {
                gate.input(0, plan(1, 10, 1_000 * MS, 0));
            }
            gate.input(0, pcm(1, 1, 0, 20));
            gate.input(0, pcm(1, 2, 20, 20));
            if prefix != 1 {
                gate.input(5 * MS, format(1));
            }
            if prefix != 2 {
                gate.input(5 * MS, plan(1, 10, 1_000 * MS, 0));
            }
            assert!(gate.input(10 * MS, pcm(1, 3, 40, 20)).is_empty());
            gate.input(10 * MS, commit(1, 10, 1_000 * MS));
            assert_eq!(played(&gate.advance(1_059 * MS)), 60);
            assert!(gate.input(1_059 * MS, pcm(1, 4, 60, 20)).is_empty());
            assert_eq!(played(&gate.advance(1_079 * MS)), 20);
        }
    }

    #[test]
    fn cached_invalid_sequence_is_reported_without_poisoning_live_watermark() {
        let mut gate = gate();
        gate.input(0, pcm(1, 1, 0, 20));
        gate.input(0, pcm(1, 1, 20, 20));
        gate.input(0, format(1));
        let actions = gate.input(0, plan(1, 10, 1_000 * MS, 0));
        assert!(actions.contains(&GateAction::DiscardPcm {
            epoch: 1,
            reason: DiscardReason::InvalidBlock,
        }));
        assert!(gate.input(0, pcm(1, 2, 20, 20)).is_empty());
    }

    #[test]
    fn matched_pcm_does_not_expire_while_waiting_for_commit_boundary() {
        let mut gate = gate();
        gate.input(0, pcm(1, 1, 0, 40));
        gate.input(5 * MS, format(1));
        gate.input(5 * MS, plan(1, 10, 1_000 * MS, 0));
        // 匹配已完成，500ms 超时不再适用。
        assert!(gate.advance(600 * MS).is_empty());
        gate.input(600 * MS, commit(1, 10, 1_000 * MS));
        assert_eq!(played(&gate.advance(1_039 * MS)), 40);
    }

    #[test]
    fn matching_after_timeout_drops_expired_blocks_and_resyncs() {
        let mut gate = gate();
        gate.input(0, pcm(1, 1, 0, 40));
        gate.input(600 * MS, format(1));
        let actions = gate.input(600 * MS, plan(1, 10, 1_000 * MS, 0));
        assert!(actions.contains(&GateAction::DiscardPcm {
            epoch: 1,
            reason: DiscardReason::UnmatchedTimeout,
        }));
        assert!(actions.contains(&GateAction::Resync { to: None }));
        gate.input(600 * MS, commit(1, 10, 1_000 * MS));
        assert_eq!(played(&gate.advance(1_039 * MS)), 0);
    }

    #[test]
    fn commit_without_format_is_rejected_until_ready() {
        let mut gate = gate();
        gate.input(0, plan(1, 10, 1_000 * MS, 0));
        assert_eq!(
            gate.input(0, commit(1, 10, 1_000 * MS)),
            vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::NotReady
            },]
        );
        assert!(gate.advance(1_000 * MS).is_empty());
        gate.input(1_000 * MS, format(1));
        gate.input(1_000 * MS, pcm(1, 1, 0, 100));
        assert!(
            gate.advance(1_050 * MS).is_empty(),
            "旧 Commit 不得在 Format 到达后复活"
        );
        gate.input(1_050 * MS, commit(1, 10, 1_200 * MS));
        assert_eq!(
            gate.advance(1_200 * MS)[0],
            GateAction::EpochSwitch {
                from: None,
                to: 1,
                at: 1_200 * MS,
            }
        );
    }

    #[test]
    fn committed_descriptors_and_boundary_are_frozen() {
        let mut gate = prepared(1000);
        gate.input(0, pcm(1, 1, 0, 100));
        gate.input(0, commit(1, 10, 1_000 * MS));
        // 相同消息幂等，冲突描述/生效时刻不得修改已提交计划。
        assert!(gate.input(10 * MS, plan(1, 10, 1_000 * MS, 0)).is_empty());
        gate.input(10 * MS, plan(1, 11, 2_000 * MS, 500));
        gate.input(
            10 * MS,
            GateInput::Format {
                session: 7,
                epoch: 1,
                format: FormatDesc {
                    format_id: 2,
                    sample_rate: 48_000,
                    channels: 1,
                },
            },
        );
        assert!(gate.input(10 * MS, commit(1, 10, 1_000 * MS)).is_empty());
        assert_eq!(
            gate.input(10 * MS, commit(1, 10, 2_000 * MS)),
            vec![GateAction::CommitIgnored {
                reason: CommitIgnoreReason::PlanMismatch
            },]
        );
        assert_eq!(played(&gate.advance(1_010 * MS)), 11);
        // 当前代际的重复描述也不能再建立新的准备槽。
        gate.input(1_010 * MS, plan(1, 11, 2_000 * MS, 0));
        assert_eq!(gate.preparing_epoch(), None);
    }

    #[test]
    fn deadlines_use_exact_rate_over_ten_minutes() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            let mut gate = prepared(rate);
            gate.input(0, pcm(1, 1, 0, rate * 700));
            gate.input(0, commit(1, 10, 1_000 * MS));
            assert_eq!(
                played(&gate.advance(601_000 * MS)),
                u64::from(rate) * 600 + 1
            );
            assert!(gate.advance(601_000 * MS).is_empty());
        }
    }

    #[test]
    fn frame_zero_is_due_at_anchor_but_not_before() {
        let mut gate = prepared(48_000);
        gate.input(0, pcm(1, 1, 0, 100));
        gate.input(0, commit(1, 10, 900 * MS));
        assert_eq!(played(&gate.advance(999 * MS)), 0);
        assert_eq!(played(&gate.advance(1_000 * MS)), 1);
    }

    #[test]
    fn silence_advances_cursor_and_late_prefix_is_never_replayed() {
        let mut gate = prepared(1000);
        gate.input(0, pcm(1, 1, 0, 100));
        gate.input(0, commit(1, 10, 1_000 * MS));
        assert_eq!(
            gate.advance(1_200 * MS),
            vec![
                GateAction::EpochSwitch {
                    from: None,
                    to: 1,
                    at: 1_000 * MS
                },
                GateAction::Play {
                    epoch: 1,
                    frames: 100
                },
                GateAction::Underrun {
                    epoch: 1,
                    frames: 101
                },
            ]
        );
        assert!(gate.advance(1_200 * MS).is_empty());
        assert_eq!(
            gate.advance(1_210 * MS),
            vec![GateAction::Underrun {
                epoch: 1,
                frames: 10
            }]
        );
        // 100..250 的迟到块只保留 211..250，不能播放已经静音呈现的前缀。
        assert!(gate.input(1_210 * MS, pcm(1, 2, 100, 150)).is_empty());
        assert!(gate.advance(1_210 * MS).is_empty());
        assert_eq!(
            gate.advance(1_249 * MS),
            vec![GateAction::Play {
                epoch: 1,
                frames: 39
            }]
        );
        assert!(gate.advance(1_249 * MS).is_empty());
    }

    #[test]
    fn future_first_block_preserves_gap_as_silence() {
        let mut gate = prepared(1000);
        gate.input(0, pcm(1, 1, 50, 50));
        gate.input(0, commit(1, 10, 1_000 * MS));
        let actions = gate.advance(1_099 * MS);
        assert_eq!(
            &actions[1..],
            &[
                GateAction::Underrun {
                    epoch: 1,
                    frames: 50
                },
                GateAction::Play {
                    epoch: 1,
                    frames: 50
                },
            ]
        );
        assert!(gate.advance(1_099 * MS).is_empty());
    }
}
