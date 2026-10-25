// SPDX-License-Identifier: MIT
//! Bounded social facts keyed by queue occurrence. Never selects playback.
use super::contract::{QueueOrder, RoomError, RoomResult};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub(super) struct Requester {
    pub member_id: Uuid,
    pub name: String,
}
struct Occurrence {
    requester: Requester,
    voters: HashSet<Uuid>,
}
#[derive(Serialize)]
pub(super) struct Activity {
    pub seq: String,
    pub kind: &'static str,
    pub member_id: Uuid,
    pub name: String,
    pub instance_id: Option<String>,
    pub at_ms: String,
}
#[derive(Default)]
pub(super) struct Collaboration {
    occurrences: HashMap<u64, Occurrence>,
    pub order: QueueOrder,
    next_activity: u64,
    pub activity: VecDeque<Activity>,
}
impl Collaboration {
    pub fn reconcile(&mut self, instances: &[u64], requester: Requester, at_ms: u64) {
        self.occurrences.retain(|id, _| instances.contains(id));
        for &id in instances {
            if let std::collections::hash_map::Entry::Vacant(entry) = self.occurrences.entry(id) {
                entry.insert(Occurrence {
                    requester: requester.clone(),
                    voters: HashSet::new(),
                });
                self.event("queue_add", requester.clone(), Some(id), at_ms);
            }
        }
    }
    pub fn event(
        &mut self,
        kind: &'static str,
        member: Requester,
        instance: Option<u64>,
        at_ms: u64,
    ) {
        // Exhaustion cannot wrap or duplicate an activity sequence.
        let Some(seq) = self.next_activity.checked_add(1) else {
            return;
        };
        self.next_activity = seq;
        self.activity.push_back(Activity {
            seq: seq.to_string(),
            kind,
            member_id: member.member_id,
            name: member.name,
            instance_id: instance.map(|id| id.to_string()),
            at_ms: at_ms.to_string(),
        });
        while self.activity.len() > 128 {
            self.activity.pop_front();
        }
    }
    pub fn vote(&mut self, instance: u64, member: Uuid, voted: bool) -> RoomResult<bool> {
        let occurrence = self
            .occurrences
            .get_mut(&instance)
            .ok_or_else(|| RoomError::invalid("队列实例已失效"))?;
        if voted && !occurrence.voters.contains(&member) && occurrence.voters.len() >= 17 {
            return Err(RoomError::invalid("投票成员超过房间容量"));
        }
        Ok(if voted {
            occurrence.voters.insert(member)
        } else {
            occurrence.voters.remove(&member)
        })
    }
    pub fn retain_members(&mut self, members: &[Uuid]) {
        for occurrence in self.occurrences.values_mut() {
            occurrence
                .voters
                .retain(|id| id.is_nil() || members.contains(id));
        }
    }
    pub fn count(&self, instance: u64) -> usize {
        self.occurrences
            .get(&instance)
            .map_or(0, |o| o.voters.len())
    }
    pub fn projection(&self, instance: u64, member: Uuid, votable: bool) -> serde_json::Value {
        let occurrence = self.occurrences.get(&instance);
        serde_json::json!({"requester":occurrence.map(|o| &o.requester), "request_order":instance.to_string(),
            "votes":self.count(instance), "voted_by_me":occurrence.is_some_and(|o| o.voters.contains(&member)), "votable":votable})
    }
    pub fn sorted_suffix(&self, instances: &[u64], frozen: usize) -> Vec<usize> {
        let mut order: Vec<_> = (0..instances.len()).collect();
        order[frozen.min(instances.len())..]
            .sort_by_key(|&i| (std::cmp::Reverse(self.count(instances[i])), instances[i]));
        order
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn votes_follow_occurrences_are_idempotent_and_only_rank_mutable_suffix() {
        let mut c = Collaboration::default();
        let member = Uuid::new_v4();
        c.reconcile(
            &[1, 2, 3, 4],
            Requester {
                member_id: member,
                name: "A".into(),
            },
            0,
        );
        assert!(c.vote(3, member, true).unwrap());
        assert!(!c.vote(3, member, true).unwrap());
        c.vote(4, member, true).unwrap();
        assert_eq!(c.sorted_suffix(&[1, 2, 4, 3], 2), [0, 1, 3, 2]);
        c.reconcile(
            &[4, 3, 1],
            Requester {
                member_id: Uuid::nil(),
                name: "Host".into(),
            },
            1,
        );
        assert_eq!(c.count(3), 1);
        assert_eq!(
            c.projection(3, member, true)["requester"]["member_id"],
            member.to_string()
        );
        assert!(c.vote(2, member, true).is_err());
        assert!(c.vote(3, member, false).unwrap());
        assert_eq!(c.count(4), 1);
        c.retain_members(&[]);
        assert_eq!(c.count(4), 0);
    }
    #[test]
    fn activity_is_bounded_and_sequences_never_replay() {
        let mut c = Collaboration::default();
        for i in 0..300 {
            c.event(
                "join",
                Requester {
                    member_id: Uuid::nil(),
                    name: "Host".into(),
                },
                None,
                i,
            );
        }
        assert_eq!(c.activity.len(), 128);
        assert_eq!(c.activity.front().unwrap().seq, "173");
        assert_eq!(c.activity.back().unwrap().seq, "300");
    }
}
