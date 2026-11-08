// SPDX-License-Identifier: MIT
//! Conservative memory accounting: references in different queues each consume budget.
use crate::protocol::{AudioFormat, PcmBlock};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

pub const ENDPOINT_BYTES: usize = 8 * 1024 * 1024;
pub const GLOBAL_BYTES: usize = 64 * 1024 * 1024;
pub const ENDPOINT_DURATION_NS: u64 = 3_000_000_000;
pub const INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const INPUT_DURATION_NS: u64 = 1_300_000_000;
pub const MIN_PCM_RATE: u32 = 44_100;
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BufferError {
    #[error("PCM window capacity exceeded")]
    Capacity,
    #[error("PCM sequence or frame discontinuity")]
    Discontinuity,
}

#[derive(Debug, Default, Clone, Copy)]
struct PcmUsage {
    frames: usize,
    bytes: usize,
    duration_ns: u64,
    input_frames: usize,
    input_bytes: usize,
    input_duration_ns: u64,
}

/// One endpoint's live PCM, including in-flight commands and simultaneous copies.
/// Its input sublimit follows a block through transport, guest and Receiver.
#[derive(Debug)]
pub struct PcmBudget {
    byte_limit: usize,
    duration_limit_ns: u64,
    input_byte_limit: usize,
    input_duration_limit_ns: u64,
    usage: Mutex<PcmUsage>,
    formats: Mutex<[Option<(u64, AudioFormat)>; 2]>,
}

impl PcmBudget {
    pub fn endpoint() -> Arc<Self> {
        Self::new(ENDPOINT_BYTES, ENDPOINT_DURATION_NS)
    }
    pub fn new(byte_limit: usize, duration_limit_ns: u64) -> Arc<Self> {
        Self::with_limits(
            byte_limit,
            duration_limit_ns,
            INPUT_BYTES,
            INPUT_DURATION_NS,
        )
    }
    pub fn with_limits(
        byte_limit: usize,
        duration_limit_ns: u64,
        input_byte_limit: usize,
        input_duration_limit_ns: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            byte_limit,
            duration_limit_ns,
            input_byte_limit: input_byte_limit.min(byte_limit),
            input_duration_limit_ns: input_duration_limit_ns.min(duration_limit_ns),
            usage: Mutex::new(PcmUsage::default()),
            formats: Mutex::new([None, None]),
        })
    }
    pub fn publish_formats(&self, formats: [Option<(u64, AudioFormat)>; 2]) {
        *self.formats.lock().unwrap_or_else(|e| e.into_inner()) = formats;
    }
    pub fn reserve_input(
        self: &Arc<Self>,
        block: &PcmBlock,
    ) -> Result<PcmReservation, BufferError> {
        let rate = self
            .formats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .flatten()
            .find(|(epoch, format)| {
                *epoch == block.epoch
                    && format.id == block.format_id
                    && format.channels == block.channels
            })
            .map_or(MIN_PCM_RATE, |(_, format)| format.sample_rate);
        self.reserve_input_at(block, rate)
    }
    /// A trusted declared Plan supplies the rate; unknown formats use MIN_PCM_RATE.
    pub fn reserve_input_at(
        self: &Arc<Self>,
        block: &PcmBlock,
        rate: u32,
    ) -> Result<PcmReservation, BufferError> {
        self.reserve(block.frame_count() as usize, rate, block.byte_len(), true)
    }
    /// Wire ingress uses bounded header dimensions before allocating decoded PCM.
    pub fn reserve_input_pcm(
        self: &Arc<Self>,
        frames: usize,
        rate: u32,
        bytes: usize,
    ) -> Result<PcmReservation, BufferError> {
        self.reserve(frames, rate, bytes, true)
    }
    /// Reserve a separately retained history/conversion/device PCM allocation.
    /// Obtain this before copying or growing a PCM buffer.
    pub fn reserve_pcm(
        self: &Arc<Self>,
        frames: usize,
        rate: u32,
        bytes: usize,
    ) -> Result<PcmReservation, BufferError> {
        self.reserve(frames, rate, bytes, false)
    }
    fn reserve(
        self: &Arc<Self>,
        frames: usize,
        rate: u32,
        bytes: usize,
        input: bool,
    ) -> Result<PcmReservation, BufferError> {
        let duration_ns = pcm_duration_ns(frames, rate)?;
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = *usage;
        next.frames = next
            .frames
            .checked_add(frames)
            .ok_or(BufferError::Capacity)?;
        next.bytes = next
            .bytes
            .checked_add(bytes)
            .filter(|n| *n <= self.byte_limit)
            .ok_or(BufferError::Capacity)?;
        next.duration_ns = next
            .duration_ns
            .checked_add(duration_ns)
            .filter(|n| *n <= self.duration_limit_ns)
            .ok_or(BufferError::Capacity)?;
        if input {
            next.input_frames = next
                .input_frames
                .checked_add(frames)
                .ok_or(BufferError::Capacity)?;
            next.input_bytes = next
                .input_bytes
                .checked_add(bytes)
                .filter(|n| *n <= self.input_byte_limit)
                .ok_or(BufferError::Capacity)?;
            next.input_duration_ns = next
                .input_duration_ns
                .checked_add(duration_ns)
                .filter(|n| *n <= self.input_duration_limit_ns)
                .ok_or(BufferError::Capacity)?;
        }
        *usage = next;
        Ok(PcmReservation {
            budget: self.clone(),
            frames,
            bytes,
            duration_ns,
            input,
        })
    }
    pub fn frames(&self) -> usize {
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).frames
    }
    pub fn bytes(&self) -> usize {
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).bytes
    }
    pub fn duration_ns(&self) -> u64 {
        self.usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .duration_ns
    }
    pub fn input_frames(&self) -> usize {
        self.usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .input_frames
    }
    pub fn input_bytes(&self) -> usize {
        self.usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .input_bytes
    }
    pub fn input_duration_ns(&self) -> u64 {
        self.usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .input_duration_ns
    }
}

fn pcm_duration_ns(frames: usize, rate: u32) -> Result<u64, BufferError> {
    if rate == 0 {
        return Err(BufferError::Capacity);
    }
    u64::try_from(
        (frames as u128)
            .checked_mul(1_000_000_000)
            .ok_or(BufferError::Capacity)?
            .div_ceil(u128::from(rate)),
    )
    .map_err(|_| BufferError::Capacity)
}

/// Move this token with its PCM. It is deliberately neither Clone nor Copy.
#[derive(Debug)]
pub struct PcmReservation {
    budget: Arc<PcmBudget>,
    frames: usize,
    bytes: usize,
    duration_ns: u64,
    input: bool,
}
impl PcmReservation {
    pub fn budget(&self) -> Arc<PcmBudget> {
        self.budget.clone()
    }
    pub fn is_from(&self, budget: &Arc<PcmBudget>) -> bool {
        Arc::ptr_eq(&self.budget, budget)
    }
    pub fn frames(&self) -> usize {
        self.frames
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn duration_ns(&self) -> u64 {
        self.duration_ns
    }
    pub fn is_input(&self) -> bool {
        self.input
    }
    /// Call only after matching the immutable epoch/format declaration.
    pub fn match_format(&mut self, rate: u32) -> Result<(), BufferError> {
        let duration_ns = pcm_duration_ns(self.frames, rate)?;
        let mut usage = self.budget.usage.lock().unwrap_or_else(|e| e.into_inner());
        let next_duration = usage
            .duration_ns
            .checked_sub(self.duration_ns)
            .and_then(|n| n.checked_add(duration_ns))
            .filter(|n| *n <= self.budget.duration_limit_ns)
            .ok_or(BufferError::Capacity)?;
        let next_input = if self.input {
            usage
                .input_duration_ns
                .checked_sub(self.duration_ns)
                .and_then(|n| n.checked_add(duration_ns))
                .filter(|n| *n <= self.budget.input_duration_limit_ns)
                .ok_or(BufferError::Capacity)?
        } else {
            usage.input_duration_ns
        };
        usage.duration_ns = next_duration;
        usage.input_duration_ns = next_input;
        self.duration_ns = duration_ns;
        Ok(())
    }
}
impl Drop for PcmReservation {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().unwrap_or_else(|e| e.into_inner());
        usage.frames -= self.frames;
        usage.bytes -= self.bytes;
        usage.duration_ns -= self.duration_ns;
        if self.input {
            usage.input_frames -= self.frames;
            usage.input_bytes -= self.bytes;
            usage.input_duration_ns -= self.duration_ns;
        }
    }
}
pub struct MemoryBudget {
    limit: usize,
    used: AtomicUsize,
}
impl MemoryBudget {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicUsize::new(0),
        })
    }
    pub fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }
    // 新 stable 把 `fetch_update` 改名成 `try_update` 并标了弃用，但 `try_update` 在 MSRV 1.88
    // 仍是 unstable feature `atomic_try_update`（`rustc +1.88.0` 报 E0658），而 1.88 这条下界是刻意
    // 守住的（见根 Cargo.toml 与 rfd 只挂 Windows/macOS 的理由）。CI 的 test 作业跑 stable 且
    // -D warnings，msrv 作业跑 1.88，所以这里只能容忍弃用，而不是换成手写 CAS 循环。
    // rust-version 一旦越过 try_update 的稳定版本，把这里和 room/receiver.rs 的四处调用一起换掉。
    #[allow(deprecated)] // MSRV 1.88 还没有 try_update
    pub(crate) fn reserve(self: &Arc<Self>, bytes: usize) -> Result<Reservation, BufferError> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|&n| n <= self.limit)
            })
            .map_err(|_| BufferError::Capacity)?;
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }
}
pub(crate) struct Reservation {
    budget: Arc<MemoryBudget>,
    bytes: usize,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct Queued {
    block: PcmBlock,
    _reservation: Reservation,
}
/// Owned and drained by non-realtime tasks. Never drop this queue on an audio callback.
pub struct PcmQueue {
    blocks: VecDeque<Queued>,
    budget: Arc<MemoryBudget>,
    byte_limit: usize,
    frame_limit: u64,
    bytes: usize,
    frames: u64,
    tail: Option<(u64, u64, u64)>,
}
impl PcmQueue {
    pub fn new(sample_rate: u32, budget: Arc<MemoryBudget>) -> Self {
        Self {
            blocks: VecDeque::new(),
            budget,
            byte_limit: ENDPOINT_BYTES,
            frame_limit: u64::from(sample_rate) * 3,
            bytes: 0,
            frames: 0,
            tail: None,
        }
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn frames(&self) -> u64 {
        self.frames
    }
    pub fn push(&mut self, block: PcmBlock) -> Result<(), BufferError> {
        if let Some((epoch, sequence, end)) = self.tail {
            if block.epoch < epoch
                || (block.epoch == epoch
                    && (block.sequence <= sequence || block.frame_index != end))
            {
                return Err(BufferError::Discontinuity);
            }
        }
        let bytes = block.byte_len();
        let frames = u64::from(block.frame_count());
        if frames == 0
            || self
                .bytes
                .checked_add(bytes)
                .is_none_or(|b| b > self.byte_limit)
            || self
                .frames
                .checked_add(frames)
                .is_none_or(|f| f > self.frame_limit)
        {
            return Err(BufferError::Capacity);
        }
        let reservation = self.budget.reserve(bytes)?;
        self.tail = Some((block.epoch, block.sequence, block.end_frame()));
        self.bytes += bytes;
        self.frames += frames;
        self.blocks.push_back(Queued {
            block,
            _reservation: reservation,
        });
        Ok(())
    }
    pub fn pop(&mut self) -> Option<PcmBlock> {
        let queued = self.blocks.pop_front()?;
        self.bytes -= queued.block.byte_len();
        self.frames -= u64::from(queued.block.frame_count());
        Some(queued.block)
    }
    pub fn clear(&mut self) {
        self.blocks.clear();
        self.bytes = 0;
        self.frames = 0;
        self.tail = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::StreamIdentity;
    use uuid::Uuid;
    fn block(seq: u64, frame: u64) -> PcmBlock {
        PcmBlock {
            identity: StreamIdentity {
                room_id: Uuid::nil(),
                instance_id: Uuid::nil(),
                session_id: Uuid::nil(),
            },
            epoch: 1,
            sequence: seq,
            frame_index: frame,
            format_id: 1,
            channels: 2,
            samples: vec![0.0; 1920].into(),
        }
    }
    #[test]
    fn shared_input_token_and_copies_obey_both_endpoint_limits() {
        let budget = PcmBudget::endpoint();
        let source = block(1, 0);
        let mut input = Vec::new();
        for _ in 0..65 {
            input.push(budget.reserve_input_at(&source, 48_000).unwrap());
        }
        assert_eq!(budget.input_duration_ns(), INPUT_DURATION_NS);
        assert!(matches!(
            budget.reserve_input_at(&source, 48_000),
            Err(BufferError::Capacity)
        ));
        let copy = budget
            .reserve_pcm(48_000 * 17 / 10, 48_000, 48_000 * 17 / 10 * 8)
            .unwrap();
        assert_eq!(budget.duration_ns(), ENDPOINT_DURATION_NS);
        assert!(matches!(
            budget.reserve_pcm(1, 192_000, 8),
            Err(BufferError::Capacity)
        ));
        let moved = input.pop().unwrap();
        assert!(moved.is_from(&budget));
        assert_eq!(budget.input_duration_ns(), INPUT_DURATION_NS);
        drop(moved);
        assert_eq!(budget.input_duration_ns(), INPUT_DURATION_NS - 20_000_000);
        drop((copy, input));
        assert_eq!(budget.bytes(), 0);
        assert_eq!(budget.duration_ns(), 0);
        assert_eq!(budget.input_frames(), 0);
    }

    #[test]
    fn unknown_formats_round_up_and_only_a_match_can_reprice() {
        let budget = PcmBudget::endpoint();
        let mut source = block(1, 0);
        source.samples = vec![0.0; 2].into();
        let mut token = budget.reserve_input(&source).unwrap();
        assert_eq!(token.duration_ns(), 22_676); // ceil(1e9 / 44100), never zero.
        token.match_format(192_000).unwrap();
        assert_eq!(budget.duration_ns(), 5_209);
        assert_eq!(budget.input_duration_ns(), 5_209);
        budget.publish_formats([
            Some((
                source.epoch,
                AudioFormat {
                    id: 1,
                    sample_rate: 96_000,
                    channels: 2,
                },
            )),
            None,
        ]);
        let known = budget.reserve_input(&source).unwrap();
        assert_eq!(known.duration_ns(), 10_417);
        drop((token, known));
        assert_eq!(budget.duration_ns(), 0);
    }

    #[test]
    fn rejected_peak_and_repricing_roll_back_all_counters() {
        let source = block(1, 0);
        let budget =
            PcmBudget::with_limits(source.byte_len(), 10_000_000, source.byte_len(), 10_000_000);
        let mut token = budget.reserve_input_at(&source, 96_000).unwrap();
        assert!(matches!(
            token.match_format(48_000),
            Err(BufferError::Capacity)
        ));
        assert_eq!(budget.duration_ns(), 10_000_000);
        assert!(matches!(
            budget.reserve_pcm(1, 192_000, 1),
            Err(BufferError::Capacity)
        ));
        assert_eq!(budget.bytes(), source.byte_len());
        drop(token);
        assert_eq!(budget.bytes(), 0);
        assert_eq!(budget.input_duration_ns(), 0);
    }
    #[test]
    fn global_capacity_is_conservative_and_released_on_drain_and_drop() {
        let size = block(1, 0).byte_len();
        let budget = MemoryBudget::new(size * 2);
        let mut a = PcmQueue::new(48_000, budget.clone());
        let mut b = PcmQueue::new(48_000, budget.clone());
        a.push(block(1, 0)).unwrap();
        b.push(block(1, 0)).unwrap();
        assert_eq!(a.push(block(2, 960)), Err(BufferError::Capacity));
        drop(b);
        assert_eq!(budget.used(), size);
        a.push(block(2, 960)).unwrap();
        assert!(a.pop().is_some());
        assert_eq!(budget.used(), size);
        a.clear();
        assert_eq!(budget.used(), 0);
    }
    #[test]
    fn frame_bound_and_sequence_survive_queue_becoming_empty() {
        let budget = MemoryBudget::new(GLOBAL_BYTES);
        let mut queue = PcmQueue::new(48_000, budget);
        queue.push(block(1, 0)).unwrap();
        queue.pop();
        assert_eq!(queue.push(block(1, 960)), Err(BufferError::Discontinuity));
        assert_eq!(queue.push(block(2, 1920)), Err(BufferError::Discontinuity));
        queue.push(block(2, 960)).unwrap();
        for i in 3..=151 {
            queue.push(block(i, (i - 1) * 960)).unwrap();
        }
        assert_eq!(
            queue.push(block(152, 151 * 960)),
            Err(BufferError::Capacity)
        );
    }
}
