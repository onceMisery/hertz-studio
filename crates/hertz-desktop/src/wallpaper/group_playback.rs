// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Group-owned selection, first-frame barriers and shared logical time.
//!
//! The caller prepares each `MemberTicket` while hidden, calls `ready`, releases
//! only the tickets returned by `take_reveals`, then acknowledges actual display
//! with `presented`. A reveal batch is the barrier's linearization point. Members
//! joining after it reconstruct that same selection without advancing the list.
//! This module owns no windows, resources, eligibility checks or video decoders.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use super::display::{ClockSample, GroupClock};
use super::jobs::JobError;
use super::playlist::{FixedVersion, Playlist, Runner, Switch};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) enum Source {
    Fixed(FixedVersion),
    Playlist(Playlist),
}

/// `key` is the stable presentation target identity, never its vector position.
/// Missing targets may be omitted; retained but paused targets use `false`.
pub(crate) struct Member {
    pub key: String,
    pub runnable: bool,
}

/// Every member receives the identical switch token, index and fixed reference.
/// Epoch fences source changes; generation fences removal, suspension and reissue.
#[derive(Clone, Debug)]
pub(crate) struct MemberTicket {
    pub epoch: u64,
    pub key: String,
    pub generation: u64,
    pub switch: Switch,
}

enum Playback {
    Fixed {
        reference: FixedVersion,
        sequence: u64,
    },
    Playlist(Runner),
}

impl Playback {
    fn new(source: Source, seed: u64) -> Result<Self> {
        Ok(match source {
            Source::Fixed(reference) => Self::Fixed {
                reference,
                sequence: 0,
            },
            Source::Playlist(playlist) => Self::Playlist(Runner::new(playlist, seed)?),
        })
    }

    fn fixed_switch(&mut self) -> Switch {
        let Self::Fixed {
            reference,
            sequence,
        } = self
        else {
            unreachable!("fixed switch requested from a playlist")
        };
        *sequence = sequence
            .checked_add(1)
            .expect("fixed switch token exhausted");
        Switch {
            index: 0,
            token: *sequence,
            reference: reference.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Preparing,
    Ready,
    Revealing,
    Presented,
}

struct MemberState {
    runnable: bool,
    generation: u64,
    stage: Stage,
    visible: Option<FixedVersion>,
    last_sample: Option<Duration>,
}

impl MemberState {
    fn new(runnable: bool) -> Self {
        Self {
            runnable,
            generation: 0,
            stage: Stage::Idle,
            visible: None,
            last_sample: None,
        }
    }
}

struct Transition {
    switch: Switch,
    released: bool,
    committed: bool,
}

pub(crate) struct GroupPlayback {
    source: Playback,
    epoch: u64,
    next_generation: u64,
    members: BTreeMap<String, MemberState>,
    transition: Option<Transition>,
    current: Option<Switch>,
    failed: bool,
    clock: Option<GroupClock>,
    clock_base: Duration,
    clock_origin: Instant,
    last_now: Instant,
    content_anchor: Option<Duration>,
}

impl GroupPlayback {
    pub(crate) fn new(source: Source, seed: u64, now: Instant) -> Result<Self> {
        Ok(Self {
            source: Playback::new(source, seed)?,
            epoch: 1,
            next_generation: 0,
            members: BTreeMap::new(),
            transition: None,
            current: None,
            failed: false,
            clock: None,
            clock_base: Duration::ZERO,
            clock_origin: now,
            last_now: now,
            content_anchor: None,
        })
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn playlist(&self) -> Option<&Playlist> {
        match &self.source {
            Playback::Playlist(runner) => Some(runner.playlist()),
            Playback::Fixed { .. } => None,
        }
    }

    pub(crate) fn current(&self) -> Option<&FixedVersion> {
        self.current.as_ref().map(|switch| &switch.reference)
    }

    pub(crate) fn current_index(&self) -> Option<usize> {
        self.current.as_ref().map(|switch| switch.index)
    }

    pub(crate) fn member_current(&self, key: &str) -> Option<&FixedVersion> {
        self.members.get(key)?.visible.as_ref()
    }

    /// Retained after the runner commits, so subsequent member acknowledgments
    /// do not become stale merely because `Runner::pending()` was cleared.
    pub(crate) fn switch(&self) -> Option<&Switch> {
        self.transition
            .as_ref()
            .map(|transition| &transition.switch)
    }

    pub(crate) fn is_failed(&self) -> bool {
        self.failed
    }

    pub(crate) fn is_switching(&self) -> bool {
        self.transition.as_ref().is_some_and(|transition| {
            !transition.committed
                || self
                    .members
                    .values()
                    .any(|member| member.runnable && member.stage != Stage::Presented)
        })
    }

    /// Validate the replacement before touching the old source. Call this for
    /// any work or playlist revision change, even when fixed references repeat.
    pub(crate) fn replace_source(&mut self, source: Source, seed: u64, now: Instant) -> Result<()> {
        self.check_time(now)?;
        let replacement = Playback::new(source, seed)?;
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| JobError::invalid_input("组播放代际已耗尽"))?;
        self.time(now);
        self.source = replacement;
        self.epoch = epoch;
        self.transition = None;
        self.current = None;
        self.content_anchor = None;
        self.failed = false;
        for member in self.members.values_mut() {
            member.stage = Stage::Idle;
            member.last_sample = None;
        }
        self.update_clock_permits(now);
        Ok(())
    }

    /// Reordering retains all state for the same keys. A stopped member loses
    /// its preparation permit; resume gets a new ticket for the current switch.
    /// An empty set freezes time and can later recover without starting at zero.
    pub(crate) fn reconcile_members(
        &mut self,
        members: impl IntoIterator<Item = Member>,
        now: Instant,
    ) -> Result<()> {
        self.check_time(now)?;
        let requested: Vec<_> = members.into_iter().collect();
        // Reuse GroupClock's identity/duplicate/member-count validation, with
        // None representing a temporarily empty group rather than a fake member.
        let replacement = if requested.is_empty() {
            None
        } else {
            Some(GroupClock::new(
                requested.iter().map(|member| member.key.clone()),
                now,
            )?)
        };
        let changed_keys = requested.len() != self.members.len()
            || requested
                .iter()
                .any(|member| !self.members.contains_key(&member.key));
        let time = self.time(now);
        let mut previous = std::mem::take(&mut self.members);
        for requested in requested {
            let mut member = previous
                .remove(&requested.key)
                .unwrap_or_else(|| MemberState::new(requested.runnable));
            if member.runnable != requested.runnable {
                member.runnable = requested.runnable;
                member.stage = Stage::Idle;
                member.last_sample = None;
            }
            self.members.insert(requested.key, member);
        }
        if changed_keys {
            self.clock = replacement;
            self.clock_base = time;
        }
        self.update_clock_permits(now);
        Ok(())
    }

    pub(crate) fn initial(&mut self) -> Option<Switch> {
        if self.transition.is_some() || self.failed {
            return None;
        }
        let switch = match &mut self.source {
            Playback::Playlist(runner) => runner.initial()?,
            Playback::Fixed { .. } => self.source.fixed_switch(),
        };
        Some(self.begin(switch))
    }

    /// A native controller may need rebuilding without a membership or source
    /// change (for example, a DPI/geometry change). Invalidate its old receipt
    /// now, then issue a fresh member ticket without resetting the group clock.
    pub(crate) fn rebuild_member(&mut self, key: &str) -> bool {
        let Some(member) = self.members.get_mut(key) else {
            return false;
        };
        member.stage = Stage::Idle;
        member.last_sample = None;
        true
    }

    pub(crate) fn next(&mut self) -> Result<Switch> {
        if self.failed {
            return Err(JobError::new("playlist_failed", "轮播已停止，请重试失败项"));
        }
        if self.is_switching() {
            return Err(JobError::new("budget_busy", "组轮播切换正在进行"));
        }
        let Playback::Playlist(runner) = &mut self.source else {
            return Err(JobError::invalid_input("固定作品没有下一项"));
        };
        let switch = runner.next()?;
        Ok(self.begin(switch))
    }

    pub(crate) fn retry(&mut self, now: Instant) -> Result<Switch> {
        self.check_time(now)?;
        if !self.failed {
            return Err(JobError::new("playlist_not_failed", "没有失败的组播放项目"));
        }
        let switch = match &mut self.source {
            Playback::Playlist(runner) => runner.retry()?,
            Playback::Fixed { .. } => self.source.fixed_switch(),
        };
        self.time(now);
        self.failed = false;
        self.update_clock_permits(now);
        Ok(self.begin(switch))
    }

    /// Runner consumes shared logical time, so a pause cannot inject wall-clock
    /// catch-up even when no ticks were delivered throughout the suspension.
    pub(crate) fn tick(&mut self, now: Instant) -> Option<Switch> {
        let time = self.time(now);
        if self.failed
            || self.is_switching()
            || !self.members.values().any(|member| member.runnable)
        {
            return None;
        }
        let logical_now = self.clock_origin.checked_add(time)?;
        let Playback::Playlist(runner) = &mut self.source else {
            return None;
        };
        let switch = runner.tick(logical_now, true)?;
        Some(self.begin(switch))
    }

    /// Drain preparation decisions once; a second call cannot schedule duplicate
    /// work. Membership recovery always uses the retained group switch.
    pub(crate) fn take_prepares(&mut self) -> Vec<MemberTicket> {
        if self.failed {
            return Vec::new();
        }
        let Some(transition) = &self.transition else {
            return Vec::new();
        };
        let mut tickets = Vec::new();
        for (key, member) in &mut self.members {
            if member.runnable && member.stage == Stage::Idle {
                self.next_generation = self
                    .next_generation
                    .checked_add(1)
                    .expect("group member ticket generation exhausted");
                member.generation = self.next_generation;
                member.stage = Stage::Preparing;
                tickets.push(MemberTicket {
                    epoch: self.epoch,
                    key: key.clone(),
                    generation: member.generation,
                    switch: transition.switch.clone(),
                });
            }
        }
        tickets
    }

    /// A hidden first frame is available. Readiness alone never commits Runner.
    pub(crate) fn ready(&mut self, ticket: &MemberTicket) -> bool {
        if !self.accepts(ticket) {
            return false;
        }
        let member = self.members.get_mut(&ticket.key).unwrap();
        match member.stage {
            Stage::Preparing => member.stage = Stage::Ready,
            Stage::Idle => return false,
            Stage::Ready | Stage::Revealing | Stage::Presented => {}
        }
        true
    }

    /// The first release establishes one content-time zero for the whole switch.
    /// Paused/missing members are excluded, and an empty set never commits it.
    /// Returned tickets are one-shot reveal decisions; already shown members do
    /// not re-enter the barrier when another member catches up.
    pub(crate) fn take_reveals(&mut self, now: Instant) -> Vec<MemberTicket> {
        if self.failed || self.transition.is_none() {
            return Vec::new();
        }
        let runnable: Vec<_> = self
            .members
            .values()
            .filter(|member| member.runnable)
            .collect();
        if runnable.is_empty()
            || runnable
                .iter()
                .any(|member| matches!(member.stage, Stage::Idle | Stage::Preparing))
        {
            return Vec::new();
        }
        let time = self.time(now);
        let transition = self.transition.as_mut().unwrap();
        if !transition.released {
            transition.released = true;
            self.content_anchor = Some(time);
        }
        let mut tickets = Vec::new();
        for (key, member) in &mut self.members {
            if member.runnable && member.stage == Stage::Ready {
                member.stage = Stage::Revealing;
                tickets.push(MemberTicket {
                    epoch: self.epoch,
                    key: key.clone(),
                    generation: member.generation,
                    switch: transition.switch.clone(),
                });
            }
        }
        tickets
    }

    /// Commit the shared runner exactly once, upon the first actual display.
    /// Later members and duplicate completion receipts remain valid without
    /// resetting the playlist interval or requiring Runner::pending().
    pub(crate) fn presented(&mut self, ticket: &MemberTicket, now: Instant) -> bool {
        if now < self.last_now || !self.accepts(ticket) {
            return false;
        }
        let member = &self.members[&ticket.key];
        if member.stage == Stage::Presented {
            return true;
        }
        if member.stage != Stage::Revealing {
            return false;
        }
        let time = self.time(now);
        let transition = self.transition.as_mut().unwrap();
        if !transition.committed {
            if let Playback::Playlist(runner) = &mut self.source {
                if !runner.presented(ticket.switch.token) {
                    return false;
                }
                // Start the interval at this confirmation, not the next poll.
                if let Some(logical_now) = self.clock_origin.checked_add(time) {
                    let _ = runner.tick(logical_now, true);
                }
            }
            transition.committed = true;
            self.current = Some(transition.switch.clone());
        }
        let member = self.members.get_mut(&ticket.key).unwrap();
        member.stage = Stage::Presented;
        member.visible = Some(ticket.switch.reference.clone());
        true
    }

    /// Keep each member's last visible reference. Any failure of this switch
    /// freezes the group and retries its exact index rather than skipping ahead.
    pub(crate) fn fail(&mut self, ticket: &MemberTicket, now: Instant) -> bool {
        if now < self.last_now || !self.accepts(ticket) {
            return false;
        }
        let transition = self.transition.as_ref().unwrap();
        if let Playback::Playlist(runner) = &mut self.source {
            let accepted = if transition.committed {
                runner.fail_current()
            } else {
                runner.fail(ticket.switch.token)
            };
            if !accepted {
                return false;
            }
        }
        self.time(now);
        self.failed = true;
        for member in self.members.values_mut() {
            member.last_sample = None;
        }
        self.update_clock_permits(now);
        true
    }

    /// Lifetime group time is monotonic through membership and content changes.
    pub(crate) fn time(&mut self, now: Instant) -> Duration {
        self.last_now = self.last_now.max(now);
        self.clock_base.saturating_add(
            self.clock
                .as_mut()
                .map_or(Duration::ZERO, |clock| clock.time(now)),
        )
    }

    /// Absolute phase for this content, shared by all mirror video presentations.
    /// Its origin is the first reveal batch, not individual decoder completion.
    pub(crate) fn content_time(&mut self, now: Instant) -> Option<Duration> {
        let anchor = self.content_anchor?;
        Some(self.time(now).saturating_sub(anchor))
    }

    /// Preserve same-key sampling across clock membership rebuilds. A resumed or
    /// newly joined member samples the current phase with zero hidden-interval dt.
    pub(crate) fn sample(&mut self, key: &str, now: Instant) -> Option<ClockSample> {
        let time = self.time(now);
        let member = self.members.get_mut(key)?;
        if !member.runnable || self.failed {
            return None;
        }
        let dt = member
            .last_sample
            .map_or(Duration::ZERO, |last| time.saturating_sub(last));
        member.last_sample = Some(time);
        Some(ClockSample { time, dt })
    }

    fn begin(&mut self, switch: Switch) -> Switch {
        self.transition = Some(Transition {
            switch: switch.clone(),
            released: false,
            committed: false,
        });
        for member in self.members.values_mut() {
            member.stage = Stage::Idle;
        }
        switch
    }

    fn accepts(&self, ticket: &MemberTicket) -> bool {
        !self.failed
            && ticket.epoch == self.epoch
            && self.members.get(&ticket.key).is_some_and(|member| {
                member.runnable
                    && member.stage != Stage::Idle
                    && member.generation == ticket.generation
            })
            && self.transition.as_ref().is_some_and(|transition| {
                let expected = &transition.switch;
                ticket.switch.token == expected.token
                    && ticket.switch.index == expected.index
                    && ticket.switch.reference == expected.reference
            })
    }

    fn check_time(&self, now: Instant) -> Result<()> {
        if now < self.last_now {
            Err(JobError::invalid_input("组播放状态时间倒退"))
        } else {
            Ok(())
        }
    }

    fn update_clock_permits(&mut self, now: Instant) {
        if let Some(clock) = &mut self.clock {
            for (key, member) in &self.members {
                clock
                    .set_running(key, member.runnable && !self.failed, now)
                    .expect("validated group members and monotonic transition time");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::playlist::Mode;
    use super::*;

    fn playlist() -> Playlist {
        Playlist {
            playlist_id: "mirror-playlist".into(),
            revision: 1,
            title: "Mirror sequence".into(),
            mode: Mode::Sequential,
            interval_seconds: 10,
            items: (0..3)
                .map(|index| FixedVersion {
                    work_key: format!("work-{index}"),
                    package_hash: format!("{index:064x}"),
                })
                .collect(),
        }
    }

    fn members(entries: &[(&str, bool)]) -> Vec<Member> {
        entries
            .iter()
            .map(|(key, runnable)| Member {
                key: (*key).into(),
                runnable: *runnable,
            })
            .collect()
    }

    fn group(now: Instant, entries: &[(&str, bool)]) -> GroupPlayback {
        let mut group = GroupPlayback::new(Source::Playlist(playlist()), 37, now).unwrap();
        group.reconcile_members(members(entries), now).unwrap();
        group.initial().unwrap();
        group
    }

    fn show(group: &mut GroupPlayback, now: Instant) -> Vec<MemberTicket> {
        let prepared = group.take_prepares();
        assert!(!prepared.is_empty());
        for ticket in &prepared {
            assert!(group.ready(ticket));
        }
        let revealed = group.take_reveals(now);
        assert_eq!(revealed.len(), prepared.len());
        for ticket in &revealed {
            assert!(group.presented(ticket, now));
        }
        revealed
    }

    #[test]
    fn hidden_frames_wait_for_all_runnable_members_and_commit_only_once() {
        let now = Instant::now();
        let mut group = group(now, &[("b", true), ("a", true), ("paused", false)]);
        let tickets = group.take_prepares();
        assert_eq!(tickets.len(), 2);
        assert_eq!(tickets[0].switch.token, tickets[1].switch.token);
        assert_eq!(tickets[0].switch.reference, tickets[1].switch.reference);
        assert!(group.initial().is_none());
        assert!(group.take_prepares().is_empty());
        assert!(!group.presented(&tickets[0], now));
        assert!(group.ready(&tickets[0]));
        assert!(group.take_reveals(now).is_empty());
        assert_eq!(group.current_index(), None);
        assert!(group.ready(&tickets[1]));
        let reveals = group.take_reveals(now);
        assert_eq!(reveals.len(), 2);
        assert!(group.take_reveals(now).is_empty());
        assert!(group.presented(&reveals[0], now));
        assert_eq!(group.current_index(), Some(0));
        assert_eq!(group.next().unwrap_err().code, "budget_busy");
        // Runner.pending is now empty, but the second member is still valid.
        assert!(group.presented(&reveals[1], now + Duration::from_secs(4)));
        assert!(group.presented(&reveals[0], now + Duration::from_secs(8)));
        let next = group.tick(now + Duration::from_secs(10)).unwrap();
        assert_eq!(next.index, 1);
        assert_eq!(group.next().unwrap_err().code, "budget_busy");
        assert!(group.tick(now + Duration::from_secs(100)).is_none());
    }

    #[test]
    fn controller_rebuild_reissues_one_member_without_resetting_content_phase() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        let shown = show(&mut group, now);
        let later = now + Duration::from_secs(4);
        assert_eq!(group.content_time(later), Some(Duration::from_secs(4)));
        assert!(group.rebuild_member("a"));
        assert!(!group.presented(&shown[0], later));
        assert!(group.presented(&shown[1], later));
        let rebuilt = group.take_prepares();
        assert_eq!(rebuilt.len(), 1);
        assert_eq!(rebuilt[0].key, "a");
        assert_eq!(rebuilt[0].switch.token, shown[0].switch.token);
        assert_ne!(rebuilt[0].generation, shown[0].generation);
        assert!(group.ready(&rebuilt[0]));
        let released = group.take_reveals(later);
        assert_eq!(released.len(), 1);
        assert!(group.presented(&released[0], later));
        assert_eq!(group.content_time(later), Some(Duration::from_secs(4)));
        assert_eq!(group.sample("a", later).unwrap().dt, Duration::ZERO);
    }

    #[test]
    fn membership_reordering_preserves_readiness_and_same_key_visible_state() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        let tickets = group.take_prepares();
        assert!(group.ready(&tickets[1]));
        group
            .reconcile_members(members(&[("b", true), ("a", true)]), now)
            .unwrap();
        assert!(group.take_prepares().is_empty());
        assert!(group.ready(&tickets[0]));
        let reveals = group.take_reveals(now);
        assert_eq!(reveals.len(), 2);
        for ticket in &reveals {
            assert!(group.presented(ticket, now));
        }
        let current = group.current().unwrap().clone();
        group
            .reconcile_members(members(&[("b", true)]), now + Duration::from_secs(1))
            .unwrap();
        assert_eq!(group.member_current("b"), Some(&current));
        assert!(group.take_prepares().is_empty());
        assert!(!group.ready(&tickets[0]));
        assert!(!group.presented(&tickets[0], now + Duration::from_secs(1)));
    }

    #[test]
    fn paused_and_removed_members_do_not_block_and_recover_the_current_switch() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        let initial = group.take_prepares();
        assert!(group.ready(&initial[0]));
        group
            .reconcile_members(members(&[("a", true), ("b", false)]), now)
            .unwrap();
        let reveal = group.take_reveals(now);
        assert_eq!(reveal.len(), 1);
        assert!(group.presented(&reveal[0], now));
        assert!(!group.ready(&initial[1]));
        let next = group.next().unwrap();
        show(&mut group, now);
        group
            .reconcile_members(members(&[("a", true), ("b", true)]), now)
            .unwrap();
        let resumed = group.take_prepares();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].key, "b");
        assert_eq!(resumed[0].switch.token, next.token);
        assert_eq!(resumed[0].switch.reference, next.reference);
        assert!(!group.ready(&initial[1]));
        assert!(group.ready(&resumed[0]));
        assert_eq!(group.take_reveals(now).len(), 1);
        assert!(group.presented(&resumed[0], now));
        assert_eq!(group.current_index(), Some(1));

        // Removal then re-addition of the same key fences old resource work,
        // even though the epoch and shared switch token have not changed.
        group
            .reconcile_members(members(&[("a", true)]), now)
            .unwrap();
        group
            .reconcile_members(members(&[("a", true), ("b", true)]), now)
            .unwrap();
        let readded = group.take_prepares();
        assert_eq!(readded[0].switch.token, resumed[0].switch.token);
        assert_ne!(readded[0].generation, resumed[0].generation);
        assert!(!group.ready(&resumed[0]));
        assert!(!group.fail(&resumed[0], now));
        assert!(group.ready(&readded[0]));
    }

    #[test]
    fn all_paused_and_empty_sets_never_release_a_vacuous_barrier() {
        let now = Instant::now();
        let mut group = group(now, &[("a", false)]);
        assert!(group.take_prepares().is_empty());
        assert!(group.take_reveals(now).is_empty());
        assert_eq!(group.current_index(), None);
        group.reconcile_members(Vec::new(), now).unwrap();
        assert!(group.take_reveals(now).is_empty());
        assert!(group.tick(now + Duration::from_secs(50)).is_none());
        group
            .reconcile_members(members(&[("a", true)]), now + Duration::from_secs(50))
            .unwrap();
        let revealed = show(&mut group, now + Duration::from_secs(50));
        assert_eq!(revealed[0].switch.index, 0);
        assert_eq!(group.time(now + Duration::from_secs(50)), Duration::ZERO);
    }

    #[test]
    fn old_tokens_references_indices_and_source_epochs_cannot_acknowledge() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true)]);
        let old = show(&mut group, now).remove(0);
        group.next().unwrap();
        let current = group.take_prepares().remove(0);
        assert!(!group.ready(&old));
        assert!(!group.fail(&old, now));
        let mut wrong = current.clone();
        wrong.switch.reference = old.switch.reference.clone();
        assert!(!group.ready(&wrong));
        wrong = current.clone();
        wrong.switch.index += 1;
        assert!(!group.ready(&wrong));

        let epoch = group.epoch();
        let mut revised = playlist();
        revised.revision += 1;
        group
            .replace_source(Source::Playlist(revised), 37, now)
            .unwrap();
        assert!(group.epoch() > epoch);
        group.initial().unwrap();
        let replacement = group.take_prepares().remove(0);
        // A new Runner repeats token 1 and index 0; epoch still rejects old work.
        assert_eq!(replacement.switch.token, old.switch.token);
        assert_eq!(replacement.switch.reference, old.switch.reference);
        assert!(!group.ready(&old));
        assert!(!group.presented(&old, now));
        assert!(!group.ready(&current));
        assert!(group.ready(&replacement));
    }

    #[test]
    fn preparation_failure_retains_visible_frame_and_retries_exact_failed_index() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        show(&mut group, now);
        let previous = group.current().unwrap().clone();
        let next = group.next().unwrap();
        let failed = group.take_prepares();
        assert!(group.ready(&failed[0]));
        assert!(group.fail(&failed[1], now + Duration::from_secs(2)));
        assert!(group.is_failed());
        assert_eq!(group.current(), Some(&previous));
        assert_eq!(group.member_current("a"), Some(&previous));
        assert_eq!(group.member_current("b"), Some(&previous));
        assert!(group.take_prepares().is_empty());
        assert!(group.take_reveals(now + Duration::from_secs(50)).is_empty());
        assert!(!group.ready(&failed[0]));
        assert!(group.tick(now + Duration::from_secs(100)).is_none());
        assert_eq!(
            group.time(now + Duration::from_secs(100)),
            Duration::from_secs(2)
        );
        assert_eq!(group.next().unwrap_err().code, "playlist_failed");

        let retried = group.retry(now + Duration::from_secs(100)).unwrap();
        assert_eq!(retried.index, next.index);
        assert_eq!(retried.reference, next.reference);
        assert_ne!(retried.token, next.token);
        assert!(group.retry(now + Duration::from_secs(100)).is_err());
        assert!(!group.fail(&failed[1], now + Duration::from_secs(100)));
        let retry_tickets = group.take_prepares();
        assert!(!group.ready(&failed[0]));
        for ticket in &retry_tickets {
            assert!(group.ready(ticket));
        }
        let reveals = group.take_reveals(now + Duration::from_secs(100));
        assert_eq!(reveals.len(), 2);
        for ticket in &reveals {
            assert!(group.presented(ticket, now + Duration::from_secs(100)));
        }
        assert_eq!(group.current_index(), Some(next.index));
    }

    #[test]
    fn renderer_failure_after_commit_retries_current_instead_of_advancing() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        let current = show(&mut group, now);
        assert!(group.fail(&current[1], now));
        assert!(!group.fail(&current[0], now));
        let retry = group.retry(now).unwrap();
        assert_eq!(retry.index, 0);
        assert_ne!(retry.token, current[0].switch.token);
        assert!(!group.presented(&current[0], now));
        show(&mut group, now);
        assert_eq!(group.current_index(), Some(0));
    }

    #[test]
    fn partial_pause_advances_playlist_and_total_pause_never_catches_up() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        show(&mut group, now);
        group
            .reconcile_members(
                members(&[("a", false), ("b", true)]),
                now + Duration::from_secs(2),
            )
            .unwrap();
        assert!(group.tick(now + Duration::from_secs(9)).is_none());
        assert_eq!(group.tick(now + Duration::from_secs(10)).unwrap().index, 1);
        show(&mut group, now + Duration::from_secs(10));
        group
            .reconcile_members(
                members(&[("a", false), ("b", false)]),
                now + Duration::from_secs(14),
            )
            .unwrap();
        assert!(group.tick(now + Duration::from_secs(100)).is_none());
        assert_eq!(
            group.time(now + Duration::from_secs(100)),
            Duration::from_secs(14)
        );
        group
            .reconcile_members(
                members(&[("a", false), ("b", true)]),
                now + Duration::from_secs(100),
            )
            .unwrap();
        let resumed = show(&mut group, now + Duration::from_secs(100));
        assert_eq!(resumed[0].switch.index, 1);
        assert!(group.tick(now + Duration::from_secs(105)).is_none());
        assert_eq!(group.tick(now + Duration::from_secs(106)).unwrap().index, 2);
    }

    #[test]
    fn shared_clock_survives_rebuild_and_resume_samples_current_phase_with_zero_dt() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        show(&mut group, now);
        assert_eq!(group.sample("b", now).unwrap().dt, Duration::ZERO);
        group
            .reconcile_members(
                members(&[("b", true), ("c", true)]),
                now + Duration::from_secs(3),
            )
            .unwrap();
        assert_eq!(
            group.sample("b", now + Duration::from_secs(4)).unwrap(),
            ClockSample {
                time: Duration::from_secs(4),
                dt: Duration::from_secs(4),
            }
        );
        assert_eq!(
            group.sample("c", now + Duration::from_secs(4)).unwrap().dt,
            Duration::ZERO
        );
        assert!(group.sample("a", now + Duration::from_secs(4)).is_none());
        group
            .reconcile_members(
                members(&[("b", true), ("c", false)]),
                now + Duration::from_secs(5),
            )
            .unwrap();
        group
            .reconcile_members(
                members(&[("b", true), ("c", true)]),
                now + Duration::from_secs(8),
            )
            .unwrap();
        assert_eq!(
            group.sample("c", now + Duration::from_secs(8)).unwrap(),
            ClockSample {
                time: Duration::from_secs(8),
                dt: Duration::ZERO,
            }
        );
        group
            .reconcile_members(Vec::new(), now + Duration::from_secs(9))
            .unwrap();
        assert_eq!(
            group.time(now + Duration::from_secs(30)),
            Duration::from_secs(9)
        );
        group
            .reconcile_members(members(&[("b", true)]), now + Duration::from_secs(30))
            .unwrap();
        assert_eq!(
            group.sample("b", now + Duration::from_secs(31)).unwrap(),
            ClockSample {
                time: Duration::from_secs(10),
                dt: Duration::ZERO,
            }
        );
    }

    #[test]
    fn content_phase_starts_at_shared_reveal_and_resets_only_for_a_new_switch() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true), ("b", true)]);
        assert_eq!(group.content_time(now), None);
        let prepared = group.take_prepares();
        for ticket in &prepared {
            assert!(group.ready(ticket));
        }
        let reveals = group.take_reveals(now + Duration::from_secs(3));
        assert_eq!(
            group.content_time(now + Duration::from_secs(3)),
            Some(Duration::ZERO)
        );
        assert!(group.presented(&reveals[0], now + Duration::from_secs(4)));
        assert!(group.presented(&reveals[1], now + Duration::from_secs(6)));
        assert_eq!(
            group.content_time(now + Duration::from_secs(6)),
            Some(Duration::from_secs(3))
        );
        group
            .reconcile_members(
                members(&[("a", true), ("b", false)]),
                now + Duration::from_secs(6),
            )
            .unwrap();
        group
            .reconcile_members(
                members(&[("a", true), ("b", true)]),
                now + Duration::from_secs(8),
            )
            .unwrap();
        show(&mut group, now + Duration::from_secs(8));
        assert_eq!(
            group.content_time(now + Duration::from_secs(8)),
            Some(Duration::from_secs(5))
        );
        group.next().unwrap();
        // Preparing the next selection does not reset the still-visible phase.
        assert_eq!(
            group.content_time(now + Duration::from_secs(9)),
            Some(Duration::from_secs(6))
        );
        show(&mut group, now + Duration::from_secs(10));
        assert_eq!(
            group.time(now + Duration::from_secs(10)),
            Duration::from_secs(10)
        );
        assert_eq!(
            group.content_time(now + Duration::from_secs(10)),
            Some(Duration::ZERO)
        );
        group
            .reconcile_members(
                members(&[("a", false), ("b", false)]),
                now + Duration::from_secs(12),
            )
            .unwrap();
        assert_eq!(
            group.content_time(now + Duration::from_secs(50)),
            Some(Duration::from_secs(2))
        );
    }

    #[test]
    fn invalid_members_and_replacement_leave_existing_transaction_intact() {
        let now = Instant::now();
        let mut group = group(now, &[("a", true)]);
        let ticket = group.take_prepares().remove(0);
        assert!(group
            .reconcile_members(members(&[("a", true), ("a", true)]), now)
            .is_err());
        assert!(group
            .reconcile_members(members(&[("", true)]), now)
            .is_err());
        assert!(group
            .reconcile_members(
                members(&[
                    ("a", true),
                    ("b", true),
                    ("c", true),
                    ("d", true),
                    ("e", true)
                ]),
                now
            )
            .is_err());
        let epoch = group.epoch();
        let mut invalid = playlist();
        invalid.items.clear();
        assert!(group
            .replace_source(Source::Playlist(invalid), 37, now)
            .is_err());
        assert_eq!(group.epoch(), epoch);
        assert!(group.ready(&ticket));
        let reveal = group.take_reveals(now + Duration::from_secs(1));
        assert_eq!(reveal.len(), 1);
        assert!(group.reconcile_members(Vec::new(), now).is_err());
        assert!(group.presented(&reveal[0], now + Duration::from_secs(1)));
    }

    #[test]
    fn fixed_work_uses_the_same_barrier_and_source_change_fences_previous_work() {
        let now = Instant::now();
        let first = playlist().items[0].clone();
        let second = playlist().items[1].clone();
        let mut group = GroupPlayback::new(Source::Fixed(first.clone()), 0, now).unwrap();
        group
            .reconcile_members(members(&[("a", true)]), now)
            .unwrap();
        group.initial().unwrap();
        let old = show(&mut group, now).remove(0);
        assert_eq!(group.current(), Some(&first));
        assert!(group.playlist().is_none());
        assert!(group.next().is_err());
        assert!(group.fail(&old, now));
        assert_eq!(group.retry(now).unwrap().reference, first);
        show(&mut group, now);
        group
            .replace_source(Source::Fixed(second.clone()), 0, now)
            .unwrap();
        group.initial().unwrap();
        assert!(!group.ready(&old));
        assert!(!group.presented(&old, now));
        show(&mut group, now);
        assert_eq!(group.current(), Some(&second));
    }
}
