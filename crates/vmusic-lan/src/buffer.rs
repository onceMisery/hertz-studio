// SPDX-License-Identifier: MIT
//! Conservative memory accounting: references in different queues each consume budget.
use crate::protocol::PcmBlock;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

pub const ENDPOINT_BYTES: usize = 8 * 1024 * 1024;
pub const GLOBAL_BYTES: usize = 64 * 1024 * 1024;
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BufferError {
    #[error("PCM window capacity exceeded")]
    Capacity,
    #[error("PCM sequence or frame discontinuity")]
    Discontinuity,
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
