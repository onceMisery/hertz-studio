// SPDX-License-Identifier: MIT
//! Bounded, timestamp-ordered facts produced by the shared renderer.
use super::contract::{RoomError, RoomResult};
use super::resources::SharedTrack;
use std::collections::HashMap;
use std::collections::VecDeque;
use vmusic_core::DspParams;

/// Identity metadata for PCM that is still audible or already distributed.
/// This has no ordering and never selects playback; AppState owns the queue.
#[derive(Clone)]
pub(super) struct PresentedTrack {
    pub track_id: String,
    pub view: Option<SharedTrack>,
}
#[derive(Default)]
pub(super) struct PresentationCatalog(HashMap<u64, PresentedTrack>);
impl PresentationCatalog {
    pub fn remember(&mut self, instance: u64, track: PresentedTrack) -> RoomResult<()> {
        if !self.0.contains_key(&instance) && self.0.len() >= CAPACITY + 16 {
            return Err(RoomError::new(
                "room_boundary_capacity",
                "呈现元数据积压，请重新创建房间",
            ));
        }
        self.0.insert(instance, track);
        Ok(())
    }
    pub fn get(&self, instance: u64) -> Option<&PresentedTrack> {
        self.0.get(&instance)
    }
    pub fn retain(&mut self, instances: &[u64]) {
        self.0.retain(|instance, _| instances.contains(instance));
    }
}

/// Requested mixer state stays separate from audible state until the producer
/// confirms the first affected PCM frame and that frame reaches presentation.
#[derive(Debug, Clone)]
pub(super) struct MixSettings {
    pub dsp: DspParams,
    pub volume: f32,
    pub crossfade_ms: u64,
    pub loudness_mode: String,
}
pub(super) struct MixChange {
    pub id: u64,
    pub settings: MixSettings,
    pub effective_at: Option<u64>,
}
#[derive(Default)]
pub(super) struct MixerTimeline {
    next_id: u64,
    pub pending: Option<MixChange>,
    completed: VecDeque<(u64, Result<u64, String>)>,
}
impl MixerTimeline {
    pub fn begin(&mut self, settings: MixSettings) -> RoomResult<u64> {
        if self.pending.is_some() {
            return Err(RoomError::new("room_busy", "请等待混音设置生效"));
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(RoomError::exhausted)?;
        self.pending = Some(MixChange {
            id: self.next_id,
            settings,
            effective_at: None,
        });
        Ok(self.next_id)
    }
    pub fn acknowledge(&mut self, id: u64, at: u64) {
        if let Some(change) = self.pending.as_mut().filter(|p| p.id == id) {
            change.effective_at = Some(at);
        }
    }
    pub fn take_due(&mut self, now: u64) -> Option<MixSettings> {
        if !self
            .pending
            .as_ref()
            .is_some_and(|p| p.effective_at.is_some_and(|at| at <= now))
        {
            return None;
        }
        let change = self.pending.take().unwrap();
        self.finish(change.id, Ok(change.effective_at.unwrap()));
        Some(change.settings)
    }
    pub fn fail(&mut self, id: u64, reason: String) {
        if self.pending.as_ref().is_some_and(|p| p.id == id) {
            self.pending = None;
            self.finish(id, Err(reason));
        }
    }
    fn finish(&mut self, id: u64, result: Result<u64, String>) {
        self.completed.push_back((id, result));
        while self.completed.len() > CAPACITY {
            self.completed.pop_front();
        }
    }
    pub fn outcome(&self, id: u64) -> Option<serde_json::Value> {
        use serde_json::json;
        if let Some(change) = self.pending.as_ref().filter(|p| p.id == id) {
            return Some(match change.effective_at {
                Some(at) => {
                    json!({"status":"scheduled","change_id":id.to_string(),"effective_at":at.to_string()})
                }
                None => json!({"status":"preparing","change_id":id.to_string()}),
            });
        }
        self.completed
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, result)| match result {
                Ok(at) => {
                    json!({"status":"applied","change_id":id.to_string(),"at":at.to_string()})
                }
                Err(reason) => {
                    json!({"status":"failed","change_id":id.to_string(),"reason":reason})
                }
            })
    }
}

const CAPACITY: usize = 256;
#[derive(Debug, Clone, Copy)]
pub(super) struct Boundary {
    pub at: u64,
    pub epoch: u64,
    pub instance: u64,
    pub position_frames: u64,
    pub ended: bool,
}
#[derive(Default)]
pub(super) struct Boundaries(VecDeque<Boundary>);
impl Boundaries {
    pub fn instances(&self) -> Vec<u64> {
        self.0.iter().map(|b| b.instance).collect()
    }
    pub fn push(&mut self, boundary: Boundary) -> RoomResult<()> {
        if self.0.len() >= CAPACITY {
            return Err(RoomError::new(
                "room_boundary_capacity",
                "渲染边界积压，请重新创建房间",
            ));
        }
        let index = self.0.partition_point(|b| b.at <= boundary.at);
        self.0.insert(index, boundary);
        Ok(())
    }
    pub fn front(&self) -> Option<&Boundary> {
        self.0.front()
    }
    pub fn pop(&mut self) -> Option<Boundary> {
        self.0.pop_front()
    }
    pub fn retain_epochs(&mut self, epochs: &[Option<u64>]) {
        self.0.retain(|b| epochs.contains(&Some(b.epoch)));
    }
    pub fn projected(
        &self,
        epoch: u64,
        at: u64,
        mut instance: u64,
        mut frames: u64,
        mut origin: u64,
        rate: u32,
    ) -> (u64, u64, bool) {
        let mut playing = true;
        for b in self.0.iter().filter(|b| b.epoch == epoch && b.at <= at) {
            if !b.ended {
                instance = b.instance;
                frames = b.position_frames;
                origin = b.at;
            } else {
                frames = frames.saturating_add(
                    ((u128::from(b.at.saturating_sub(origin)) * u128::from(rate)) / 1_000_000_000)
                        as u64,
                );
                origin = b.at;
                playing = false;
            }
        }
        if playing {
            frames = frames.saturating_add(
                ((u128::from(at.saturating_sub(origin)) * u128::from(rate)) / 1_000_000_000) as u64,
            );
        }
        (instance, frames, playing)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_queue_instances_keep_their_metadata_until_the_rendered_prefix_retires() {
        let mut catalog = PresentationCatalog::default();
        catalog
            .remember(
                1,
                PresentedTrack {
                    track_id: "a".into(),
                    view: None,
                },
            )
            .unwrap();
        catalog
            .remember(
                2,
                PresentedTrack {
                    track_id: "b".into(),
                    view: None,
                },
            )
            .unwrap();
        let mut boundaries = Boundaries::default();
        boundaries
            .push(Boundary {
                at: 500,
                epoch: 1,
                instance: 2,
                position_frames: 0,
                ended: false,
            })
            .unwrap();
        // The authoritative queue now contains A only. The distributed future
        // PCM still selects B at its recorded boundary and keeps B's identity.
        let queue = [1];
        assert!(!queue.contains(&2));
        let mut retained = boundaries.instances();
        retained.push(1);
        catalog.retain(&retained);
        assert_eq!(catalog.get(2).unwrap().track_id, "b");
        assert_eq!(boundaries.projected(1, 600, 1, 0, 0, 48_000).0, 2);
        boundaries.retain_epochs(&[]);
        catalog.retain(&queue);
        assert!(catalog.get(2).is_none());
    }
    #[test]
    fn mixer_waits_for_pcm_acknowledgement_and_presentation_then_reports_applied() {
        let mut timeline = MixerTimeline::default();
        let settings = MixSettings {
            dsp: DspParams::default(),
            volume: 0.3,
            crossfade_ms: 500,
            loudness_mode: "track".into(),
        };
        let id = timeline.begin(settings.clone()).unwrap();
        assert!(timeline.begin(settings).is_err());
        assert!(timeline.take_due(u64::MAX).is_none());
        assert_eq!(timeline.outcome(id).unwrap()["status"], "preparing");
        timeline.acknowledge(id + 1, 1);
        assert!(timeline.take_due(u64::MAX).is_none());
        timeline.acknowledge(id, 500);
        assert!(timeline.take_due(499).is_none());
        assert_eq!(timeline.outcome(id).unwrap()["status"], "scheduled");
        assert_eq!(timeline.take_due(500).unwrap().volume, 0.3);
        assert_eq!(timeline.outcome(id).unwrap()["status"], "applied");
        assert!(timeline.take_due(501).is_none());
    }
    #[test]
    fn future_candidate_does_not_block_old_audible_boundary() {
        let mut q = Boundaries::default();
        q.push(Boundary {
            at: 1050,
            epoch: 2,
            instance: 3,
            position_frames: 0,
            ended: false,
        })
        .unwrap();
        q.push(Boundary {
            at: 500,
            epoch: 1,
            instance: 2,
            position_frames: 0,
            ended: false,
        })
        .unwrap();
        assert_eq!(q.pop().unwrap().at, 500);
        assert_eq!(q.front().unwrap().at, 1050);
    }
    #[test]
    fn pause_uses_track_and_position_at_future_boundary() {
        let mut q = Boundaries::default();
        q.push(Boundary {
            at: 100_000_000,
            epoch: 1,
            instance: 2,
            position_frames: 2400,
            ended: false,
        })
        .unwrap();
        assert_eq!(
            q.projected(1, 1_000_000_000, 1, 96_000, 0, 48_000),
            (2, 45_600, true)
        );
        q.push(Boundary {
            at: 500_000_000,
            epoch: 1,
            instance: 2,
            position_frames: 0,
            ended: true,
        })
        .unwrap();
        assert_eq!(
            q.projected(1, 1_000_000_000, 1, 96_000, 0, 48_000),
            (2, 21_600, false)
        );
    }
    #[test]
    fn capacity_and_epoch_retirement_are_explicit() {
        let mut q = Boundaries::default();
        for at in 0..CAPACITY {
            q.push(Boundary {
                at: at as u64,
                epoch: 1,
                instance: 1,
                position_frames: 0,
                ended: false,
            })
            .unwrap();
        }
        assert!(q
            .push(Boundary {
                at: 999,
                epoch: 2,
                instance: 2,
                position_frames: 0,
                ended: false
            })
            .is_err());
        q.retain_epochs(&[Some(2)]);
        assert!(q.front().is_none());
    }
}
