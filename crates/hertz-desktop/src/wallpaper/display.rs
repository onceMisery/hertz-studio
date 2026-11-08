// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Display intent, topology grace and shared clocks. This module owns no windows,
//! persisted configuration, resource reservations or monitor enumeration.
//! Every returned presentation still needs its own existing planner/budget grant.
//!
//! Identity is exactly `WallpaperMonitor::display_id()`. Duplicate identities are
//! ambiguous; absent identities and unresolved legacy names are never matched by
//! model/name or redirected to the primary display. Native currently exposes no
//! EDID serial/ambiguity fact, so different paths of identical serial-less devices
//! cannot be proved to identify the same physical unit after a connector swap.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::budget::MAX_PRESENTATION_TARGETS;
use super::config::{DisplaySelection, LayoutMode, WallpaperGroup};
use super::jobs::JobError;
use super::policy::{DISPLAY_MISSING_HITS, TOPOLOGY_INTERVAL};
use crate::native::WallpaperMonitor;

pub(crate) type DisplayError = JobError;
type Result<T> = std::result::Result<T, DisplayError>;

const MAX_GROUPS: usize = 4;
const MAX_MEMBERS: usize = 4;
const MAX_ENUMERATED_MONITORS: usize = 128;
pub(crate) const EMPTY_TOPOLOGY_GRACE: Duration = Duration::from_millis(500);
pub(crate) const VIDEO_SYNC_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) const VIDEO_SYNC_TOLERANCE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhysicalBounds {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

impl PhysicalBounds {
    fn from_monitor(monitor: &WallpaperMonitor) -> Result<Self> {
        let width = u32::try_from(monitor.width)
            .map_err(|_| DisplayError::invalid_input("显示器物理宽度无效"))?;
        let height = u32::try_from(monitor.height)
            .map_err(|_| DisplayError::invalid_input("显示器物理高度无效"))?;
        Self::checked(monitor.left, monitor.top, width, height)
    }

    fn checked(left: i32, top: i32, width: u32, height: u32) -> Result<Self> {
        // The native bitmap/handoff path already defines the maximum physical
        // surface. Reuse that boundary instead of inventing another pixel budget.
        super::handoff::target_pixels(width, height)?;
        i32::try_from(i64::from(left) + i64::from(width))
            .map_err(|_| DisplayError::invalid_input("显示器物理右边界溢出"))?;
        i32::try_from(i64::from(top) + i64::from(height))
            .map_err(|_| DisplayError::invalid_input("显示器物理下边界溢出"))?;
        Ok(Self {
            left,
            top,
            width,
            height,
        })
    }

    fn enclosing(members: &[DisplayMember]) -> Result<Self> {
        let first = members
            .first()
            .ok_or_else(|| DisplayError::invalid_input("跨屏目标没有成员"))?;
        let mut left = i64::from(first.bounds.left);
        let mut top = i64::from(first.bounds.top);
        let mut right = left + i64::from(first.bounds.width);
        let mut bottom = top + i64::from(first.bounds.height);
        for member in &members[1..] {
            left = left.min(i64::from(member.bounds.left));
            top = top.min(i64::from(member.bounds.top));
            right = right.max(i64::from(member.bounds.left) + i64::from(member.bounds.width));
            bottom = bottom.max(i64::from(member.bounds.top) + i64::from(member.bounds.height));
        }
        let width = u32::try_from(right - left)
            .map_err(|_| DisplayError::invalid_input("跨屏物理宽度溢出"))?;
        let height = u32::try_from(bottom - top)
            .map_err(|_| DisplayError::invalid_input("跨屏物理高度溢出"))?;
        Self::checked(left as i32, top as i32, width, height)
    }

    fn intersects_monitor(self, monitor: &WallpaperMonitor) -> bool {
        monitor.width > 0
            && monitor.height > 0
            && i64::from(self.left) < i64::from(monitor.left) + i64::from(monitor.width)
            && i64::from(monitor.left) < i64::from(self.left) + i64::from(self.width)
            && i64::from(self.top) < i64::from(monitor.top) + i64::from(monitor.height)
            && i64::from(monitor.top) < i64::from(self.top) + i64::from(self.height)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayMember {
    pub display_id: String,
    pub selection_index: usize,
    pub name: String,
    pub bounds: PhysicalBounds,
    pub dpi: u32,
    pub refresh_hz: u32,
    pub primary: bool,
    #[serde(skip)]
    device_path: Option<String>,
    #[serde(skip)]
    edid_digest: Option<String>,
}

impl DisplayMember {
    fn new(monitor: &WallpaperMonitor, selection_index: usize) -> Result<Self> {
        if monitor.dpi == 0 || !(5..=1000).contains(&monitor.refresh_hz) {
            return Err(DisplayError::invalid_input("显示器 DPI 或刷新率无效"));
        }
        Ok(Self {
            display_id: monitor.display_id(),
            selection_index,
            name: monitor.name.clone(),
            bounds: PhysicalBounds::from_monitor(monitor)?,
            dpi: monitor.dpi,
            refresh_hz: monitor.refresh_hz,
            primary: monitor.primary,
            device_path: monitor.device_path.clone(),
            edid_digest: monitor.edid_digest.clone(),
        })
    }

    pub(crate) fn monitor(&self) -> WallpaperMonitor {
        WallpaperMonitor {
            name: self.name.clone(),
            left: self.bounds.left,
            top: self.bounds.top,
            width: self.bounds.width as i32,
            height: self.bounds.height as i32,
            dpi: self.dpi,
            primary: self.primary,
            refresh_hz: self.refresh_hz,
            device_path: self.device_path.clone(),
            edid_digest: self.edid_digest.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayTarget {
    pub id: String,
    pub group_id: String,
    pub mode: LayoutMode,
    pub bounds: PhysicalBounds,
    pub dpi: u32,
    pub refresh_hz: u32,
    /// Configuration order, never monitor enumeration or coordinate order.
    pub members: Vec<DisplayMember>,
    /// Keep an existing surface through grace; do not create/remount this target.
    pub retained: bool,
}

impl DisplayTarget {
    fn individual(group: &WallpaperGroup, member: DisplayMember) -> Self {
        Self {
            id: format!("{}/display/{}", group.id, member.display_id),
            group_id: group.id.clone(),
            mode: group.mode,
            bounds: member.bounds,
            dpi: member.dpi,
            refresh_hz: member.refresh_hz,
            members: vec![member],
            retained: false,
        }
    }

    fn span(group: &WallpaperGroup, members: Vec<DisplayMember>) -> Result<Self> {
        Ok(Self {
            id: format!("{}/span", group.id),
            group_id: group.id.clone(),
            mode: group.mode,
            bounds: PhysicalBounds::enclosing(&members)?,
            // One physical canvas. No member's CSS DPR represents the whole span.
            dpi: 96,
            refresh_hz: members
                .iter()
                .map(|member| member.refresh_hz)
                .min()
                .unwrap(),
            members,
            retained: false,
        })
    }

    /// Adapter for the existing native target/mount path. For span, consumers
    /// must use `members` for coverage policy; this synthetic monitor is a canvas.
    pub(crate) fn monitor(&self) -> WallpaperMonitor {
        if self.mode != LayoutMode::Span {
            return self.members[0].monitor();
        }
        WallpaperMonitor {
            name: self.id.clone(),
            left: self.bounds.left,
            top: self.bounds.top,
            width: self.bounds.width as i32,
            height: self.bounds.height as i32,
            dpi: 96,
            primary: self.members.iter().any(|member| member.primary),
            refresh_hz: self.refresh_hz,
            device_path: Some(self.id.clone()),
            edid_digest: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DisplayState {
    Waiting,
    Missing,
    Ambiguous,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayDiagnostic {
    pub group_id: String,
    pub member_index: Option<usize>,
    pub state: DisplayState,
    pub reason: &'static str,
}

impl DisplayDiagnostic {
    fn new(
        group: &WallpaperGroup,
        member_index: Option<usize>,
        state: DisplayState,
        reason: &'static str,
    ) -> Self {
        Self {
            group_id: group.id.clone(),
            member_index,
            state,
            reason,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayPlan {
    pub generation: u64,
    pub targets: Vec<DisplayTarget>,
    pub diagnostics: Vec<DisplayDiagnostic>,
    pub topology_empty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetTicket {
    pub generation: u64,
    pub target_id: String,
}

impl DisplayPlan {
    pub(crate) fn ticket(&self, target_id: &str) -> Option<TargetTicket> {
        self.targets
            .iter()
            .any(|target| target.id == target_id && !target.retained)
            .then(|| TargetTicket {
                generation: self.generation,
                target_id: target_id.into(),
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GroupLayout {
    id: String,
    mode: LayoutMode,
    displays: Vec<DisplaySelection>,
}

impl From<&WallpaperGroup> for GroupLayout {
    fn from(group: &WallpaperGroup) -> Self {
        Self {
            id: group.id.clone(),
            mode: group.mode,
            displays: group.displays.clone(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MonitorFingerprint {
    id: String,
    name: String,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    dpi: u32,
    refresh_hz: u32,
    primary: bool,
}

impl From<&WallpaperMonitor> for MonitorFingerprint {
    fn from(monitor: &WallpaperMonitor) -> Self {
        Self {
            id: monitor.display_id(),
            name: monitor.name.clone(),
            left: monitor.left,
            top: monitor.top,
            width: monitor.width,
            height: monitor.height,
            dpi: monitor.dpi,
            refresh_hz: monitor.refresh_hz,
            primary: monitor.primary,
        }
    }
}

#[derive(Default)]
struct Absence {
    hits: u8,
    last: Option<Instant>,
}

impl Absence {
    fn observe(&mut self, now: Instant) -> bool {
        if self
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= TOPOLOGY_INTERVAL)
        {
            self.hits = self.hits.saturating_add(1).min(DISPLAY_MISSING_HITS);
            self.last = Some(now);
        }
        self.hits >= DISPLAY_MISSING_HITS
    }
}

enum MemberResolution {
    Ready(DisplayMember),
    Absent,
    Blocked(DisplayState, &'static str),
}

/// Persistent, bounded runtime state. Call with native snapshots at the existing
/// topology cadence. A zero-monitor snapshot breaks consecutive nonempty misses.
#[derive(Default)]
pub(crate) struct DisplayTopology {
    current: DisplayPlan,
    layouts: Vec<GroupLayout>,
    monitors: Vec<MonitorFingerprint>,
    absences: BTreeMap<(String, usize), Absence>,
    empty_since: Option<Instant>,
    empty_checks: Absence,
    last_observation: Option<Instant>,
}

/// Structural validation is independent of which displays happen to be online.
/// Span costs one presentation; mirror costs one for each configured member.
pub(crate) fn requested_target_count(groups: &[WallpaperGroup]) -> Result<usize> {
    if groups.is_empty() || groups.len() > MAX_GROUPS {
        return Err(DisplayError::invalid_input(
            "壁纸显示组数量必须在 1–4 范围内",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut targets = 0;
    for group in groups {
        if group.id.is_empty()
            || group.id.len() > 128
            || !group
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !ids.insert(&group.id)
        {
            return Err(DisplayError::invalid_input("显示组身份无效或重复"));
        }
        if group.displays.is_empty()
            || group.displays.len() > MAX_MEMBERS
            || (group.mode == LayoutMode::Single && group.displays.len() != 1)
        {
            return Err(DisplayError::invalid_input("显示组成员数量无效"));
        }
        for selection in &group.displays {
            let valid = match selection {
                DisplaySelection::Primary => true,
                DisplaySelection::Fixed { display_id } => {
                    !display_id.is_empty()
                        && display_id.len() <= 256
                        && display_id.trim() == display_id
                        && !display_id.chars().any(char::is_control)
                }
                DisplaySelection::Unresolved { legacy_name } => {
                    !legacy_name.is_empty() && legacy_name.len() <= 256
                }
            };
            if !valid {
                return Err(DisplayError::invalid_input("显示器选择身份无效"));
            }
        }
        targets += if group.mode == LayoutMode::Mirror {
            group.displays.len()
        } else {
            1
        };
    }
    if targets > MAX_PRESENTATION_TARGETS as usize {
        return Err(DisplayError::new(
            "presentation_target_limit",
            "呈现目标超过现有全局上限 4",
        ));
    }
    Ok(targets)
}

fn resolve_member(
    selection: &DisplaySelection,
    selection_index: usize,
    monitors: &[WallpaperMonitor],
) -> MemberResolution {
    if matches!(selection, DisplaySelection::Unresolved { .. }) {
        return MemberResolution::Blocked(DisplayState::Waiting, "unresolved_selection");
    }
    let candidates: Vec<_> = monitors
        .iter()
        .filter(|monitor| match selection {
            DisplaySelection::Primary => monitor.primary,
            DisplaySelection::Fixed { display_id } => monitor.display_id() == *display_id,
            DisplaySelection::Unresolved { .. } => false,
        })
        .collect();
    if candidates.is_empty() {
        return MemberResolution::Absent;
    }
    if candidates.len() != 1 {
        return MemberResolution::Blocked(DisplayState::Ambiguous, "ambiguous_display");
    }
    let candidate = candidates[0];
    // Primary resolves to an actual identity before uniqueness is checked.
    if monitors
        .iter()
        .filter(|monitor| monitor.display_id() == candidate.display_id())
        .count()
        != 1
    {
        return MemberResolution::Blocked(DisplayState::Ambiguous, "ambiguous_display");
    }
    match DisplayMember::new(candidate, selection_index) {
        Ok(member) => MemberResolution::Ready(member),
        Err(_) => MemberResolution::Blocked(DisplayState::Waiting, "invalid_target_geometry"),
    }
}

impl DisplayTopology {
    pub(crate) fn current(&self) -> &DisplayPlan {
        &self.current
    }

    pub(crate) fn accepts(&self, ticket: &TargetTicket) -> bool {
        ticket.generation == self.current.generation
            && self.current.ticket(&ticket.target_id).is_some()
    }

    pub(crate) fn reconcile(
        &mut self,
        groups: &[WallpaperGroup],
        monitors: &[WallpaperMonitor],
        now: Instant,
    ) -> Result<DisplayPlan> {
        requested_target_count(groups)?;
        if monitors.len() > MAX_ENUMERATED_MONITORS {
            return Err(DisplayError::invalid_input("显示器拓扑超过枚举上限"));
        }
        if self.last_observation.is_some_and(|last| now < last) {
            return Err(DisplayError::invalid_input("显示器拓扑观察时间倒退"));
        }
        let layouts: Vec<_> = groups.iter().map(GroupLayout::from).collect();
        let changed_groups: BTreeSet<_> = layouts
            .iter()
            .filter(|layout| !self.layouts.contains(layout))
            .map(|layout| layout.id.as_str())
            .collect();
        self.absences.retain(|(group_id, _), _| {
            layouts.iter().any(|layout| layout.id == *group_id)
                && !changed_groups.contains(group_id.as_str())
        });
        let mut plan = DisplayPlan {
            topology_empty: monitors.is_empty(),
            ..Default::default()
        };
        if monitors.is_empty() {
            self.absences.clear();
            let since = *self.empty_since.get_or_insert(now);
            let rechecked = self.empty_checks.observe(now);
            let expired = rechecked && now.duration_since(since) >= EMPTY_TOPOLOGY_GRACE;
            for group in groups {
                plan.diagnostics.push(DisplayDiagnostic::new(
                    group,
                    None,
                    DisplayState::Waiting,
                    if expired {
                        "empty_topology"
                    } else {
                        "empty_topology_grace"
                    },
                ));
                if !expired && !changed_groups.contains(group.id.as_str()) {
                    self.retain_targets(group, None, &mut plan.targets);
                }
            }
        } else {
            self.empty_since = None;
            self.empty_checks = Absence::default();
            self.resolve_nonempty(groups, monitors, now, &changed_groups, &mut plan);
        }
        // Sort only the topology fingerprint. Configuration member/target order is
        // preserved and an OS enumeration reorder cannot trigger a remount.
        let mut fingerprint: Vec<_> = monitors.iter().map(MonitorFingerprint::from).collect();
        fingerprint.sort();
        let changed = self.current.generation == 0
            || self.layouts != layouts
            || self.monitors != fingerprint
            || self.current.targets != plan.targets
            || self.current.diagnostics != plan.diagnostics;
        plan.generation = if changed {
            self.current
                .generation
                .checked_add(1)
                .ok_or_else(|| DisplayError::new("generation_exhausted", "显示器拓扑代际已耗尽"))?
        } else {
            self.current.generation
        };
        self.layouts = layouts;
        self.monitors = fingerprint;
        self.last_observation = Some(now);
        self.current = plan.clone();
        Ok(plan)
    }

    fn retain_targets(
        &self,
        group: &WallpaperGroup,
        index: Option<usize>,
        output: &mut Vec<DisplayTarget>,
    ) {
        for target in &self.current.targets {
            if target.group_id == group.id
                && target.mode == group.mode
                && index.is_none_or(|index| {
                    target
                        .members
                        .iter()
                        .any(|member| member.selection_index == index)
                })
            {
                let mut retained = target.clone();
                retained.retained = true;
                output.push(retained);
            }
        }
    }

    fn resolve_nonempty(
        &mut self,
        groups: &[WallpaperGroup],
        monitors: &[WallpaperMonitor],
        now: Instant,
        changed_groups: &BTreeSet<&str>,
        plan: &mut DisplayPlan,
    ) {
        let resolutions: Vec<Vec<_>> = groups
            .iter()
            .map(|group| {
                group
                    .displays
                    .iter()
                    .enumerate()
                    .map(|(index, selection)| resolve_member(selection, index, monitors))
                    .collect()
            })
            .collect();
        let mut claims: BTreeMap<&str, Vec<(usize, usize)>> = BTreeMap::new();
        for (group_index, members) in resolutions.iter().enumerate() {
            for (member_index, member) in members.iter().enumerate() {
                if let MemberResolution::Ready(member) = member {
                    claims
                        .entry(&member.display_id)
                        .or_default()
                        .push((group_index, member_index));
                }
            }
        }
        let mut conflicts = BTreeSet::new();
        for owners in claims.values().filter(|owners| owners.len() > 1) {
            for &(group_index, member_index) in owners {
                conflicts.insert(group_index);
                plan.diagnostics.push(DisplayDiagnostic::new(
                    &groups[group_index],
                    Some(member_index),
                    DisplayState::Ambiguous,
                    "display_claimed_twice",
                ));
            }
        }
        for (group_index, group) in groups.iter().enumerate() {
            if conflicts.contains(&group_index) {
                self.absences
                    .retain(|(group_id, _), _| *group_id != group.id);
                continue;
            }
            let mut complete = true;
            let mut can_retain = !changed_groups.contains(group.id.as_str());
            let mut ready_members = Vec::new();
            for (index, member) in resolutions[group_index].iter().enumerate() {
                let absence_key = (group.id.clone(), index);
                match member {
                    MemberResolution::Ready(member) => {
                        self.absences.remove(&absence_key);
                        if group.mode == LayoutMode::Span {
                            ready_members.push(member.clone());
                        } else {
                            plan.targets
                                .push(DisplayTarget::individual(group, member.clone()));
                        }
                    }
                    MemberResolution::Absent => {
                        complete = false;
                        let missing = self.absences.entry(absence_key).or_default().observe(now);
                        plan.diagnostics.push(DisplayDiagnostic::new(
                            group,
                            Some(index),
                            if missing {
                                DisplayState::Missing
                            } else {
                                DisplayState::Waiting
                            },
                            if missing {
                                "display_missing"
                            } else {
                                "display_missing_grace"
                            },
                        ));
                        if missing {
                            can_retain = false;
                        } else if group.mode != LayoutMode::Span
                            && !changed_groups.contains(group.id.as_str())
                        {
                            self.retain_targets(group, Some(index), &mut plan.targets);
                        }
                    }
                    MemberResolution::Blocked(state, reason) => {
                        complete = false;
                        can_retain = false;
                        self.absences.remove(&absence_key);
                        plan.diagnostics.push(DisplayDiagnostic::new(
                            group,
                            Some(index),
                            *state,
                            reason,
                        ));
                    }
                }
            }
            if group.mode == LayoutMode::Span {
                if complete {
                    match DisplayTarget::span(group, ready_members) {
                        Ok(target) => plan.targets.push(target),
                        Err(_) => plan.diagnostics.push(DisplayDiagnostic::new(
                            group,
                            None,
                            DisplayState::Waiting,
                            "invalid_span_geometry",
                        )),
                    }
                } else if can_retain {
                    self.retain_targets(group, None, &mut plan.targets);
                }
            }
        }
        // A rectangular span can cover an unselected screen between its members.
        // Validate its real coverage, including retained grace targets. Empty space
        // between screens and shared edges remain valid; only positive-area overlap
        // claims a connected display. Reject its other owner just like an ID clash.
        let mut coverage_conflicts = BTreeSet::new();
        let mut covered_members = BTreeSet::new();
        for target in plan
            .targets
            .iter()
            .filter(|target| target.mode == LayoutMode::Span)
        {
            let mut invalid = false;
            for monitor in monitors {
                let display_id = monitor.display_id();
                let selected = target
                    .members
                    .iter()
                    .any(|member| member.display_id == display_id);
                let owners = claims.get(display_id.as_str());
                let claimed_elsewhere = owners.is_some_and(|owners| {
                    owners
                        .iter()
                        .any(|(group_index, _)| groups[*group_index].id != target.group_id)
                });
                if !target.bounds.intersects_monitor(monitor) || (selected && !claimed_elsewhere) {
                    continue;
                }
                invalid = true;
                for &(group_index, member_index) in owners.into_iter().flatten() {
                    if groups[group_index].id == target.group_id {
                        continue;
                    }
                    coverage_conflicts.insert(groups[group_index].id.clone());
                    if covered_members.insert((group_index, member_index)) {
                        plan.diagnostics.push(DisplayDiagnostic::new(
                            &groups[group_index],
                            Some(member_index),
                            DisplayState::Ambiguous,
                            "display_claimed_twice",
                        ));
                    }
                }
            }
            if invalid {
                coverage_conflicts.insert(target.group_id.clone());
                let group = groups
                    .iter()
                    .find(|group| group.id == target.group_id)
                    .expect("planned span group");
                plan.diagnostics.push(DisplayDiagnostic::new(
                    group,
                    None,
                    DisplayState::Waiting,
                    "invalid_span_geometry",
                ));
            }
        }
        plan.targets
            .retain(|target| !coverage_conflicts.contains(&target.group_id));
        self.absences
            .retain(|(group_id, _), _| !coverage_conflicts.contains(group_id));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TimeModel {
    Absolute,
    Integrated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MirrorEligibility {
    pub time_model: TimeModel,
    pub reconstructable: bool,
}

impl MirrorEligibility {
    pub(crate) fn image() -> Self {
        Self {
            time_model: TimeModel::Absolute,
            reconstructable: true,
        }
    }

    pub(crate) fn video() -> Self {
        Self::image()
    }

    /// The current registry declares neither absolute reconstruction nor a
    /// matching factory implementation. A scene name cannot establish that fact.
    pub(crate) fn builtin(_scene_id: &str) -> Self {
        Self {
            time_model: TimeModel::Integrated,
            reconstructable: false,
        }
    }

    pub(crate) fn allows_mirror(self) -> bool {
        self.time_model == TimeModel::Absolute && self.reconstructable
    }
}

/// Call with the resolved content's eligibility before granting/mounting a
/// mirror target. A package/playlist reference alone proves no content property.
pub(crate) fn validate_mirror(
    group: &WallpaperGroup,
    eligibility: MirrorEligibility,
) -> Result<()> {
    if group.mode == LayoutMode::Mirror && !eligibility.allows_mirror() {
        return Err(DisplayError::new(
            "mirror_time_model",
            "镜像需要可重建的绝对时间采样，当前作品依赖积分历史",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClockSample {
    pub time: Duration,
    pub dt: Duration,
}

struct ClockMember {
    id: String,
    running: bool,
    last_sample: Option<Duration>,
}

/// One shared logical clock. Runtime policy determines each member's run permit;
/// every state transition is timestamped before changing that permit.
pub(crate) struct GroupClock {
    members: Vec<ClockMember>,
    last_update: Instant,
    elapsed: Duration,
}

impl GroupClock {
    pub(crate) fn new(member_ids: impl IntoIterator<Item = String>, now: Instant) -> Result<Self> {
        let mut members = Vec::new();
        for id in member_ids {
            if id.is_empty()
                || id.len() > 1024
                || members.len() >= MAX_MEMBERS
                || members.iter().any(|member: &ClockMember| member.id == id)
            {
                return Err(DisplayError::invalid_input(
                    "组时钟成员身份无效、重复或过多",
                ));
            }
            members.push(ClockMember {
                id,
                running: false,
                last_sample: None,
            });
        }
        if members.is_empty() {
            return Err(DisplayError::invalid_input("组时钟没有成员"));
        }
        Ok(Self {
            members,
            last_update: now,
            elapsed: Duration::ZERO,
        })
    }

    pub(crate) fn member_ids(&self) -> impl Iterator<Item = &str> {
        self.members.iter().map(|member| member.id.as_str())
    }

    fn advance(&mut self, now: Instant) {
        if now < self.last_update {
            return;
        }
        if self.members.iter().any(|member| member.running) {
            self.elapsed = self
                .elapsed
                .saturating_add(now.duration_since(self.last_update));
        }
        self.last_update = now;
    }

    pub(crate) fn set_running(&mut self, id: &str, running: bool, now: Instant) -> Result<()> {
        let index = self
            .members
            .iter()
            .position(|member| member.id == id)
            .ok_or_else(|| DisplayError::invalid_input("组时钟成员不存在"))?;
        if now < self.last_update {
            return Err(DisplayError::invalid_input("组时钟状态时间倒退"));
        }
        self.advance(now);
        let member = &mut self.members[index];
        if member.running != running {
            member.running = running;
            // Resume samples the current group time, including after resources
            // were unloaded. It must not integrate the member's hidden interval.
            member.last_sample = None;
        }
        Ok(())
    }

    pub(crate) fn time(&mut self, now: Instant) -> Duration {
        self.advance(now);
        self.elapsed
    }

    pub(crate) fn sample(&mut self, id: &str, now: Instant) -> Option<ClockSample> {
        self.advance(now);
        let member = self
            .members
            .iter_mut()
            .find(|member| member.id == id && member.running)?;
        let sample = ClockSample {
            time: self.elapsed,
            dt: member
                .last_sample
                .map_or(Duration::ZERO, |last| self.elapsed.saturating_sub(last)),
        };
        member.last_sample = Some(self.elapsed);
        Some(sample)
    }
}

pub(crate) fn looped_video_time(group_time: Duration, duration: Duration) -> Option<Duration> {
    if duration.is_zero() {
        return None;
    }
    let nanos = group_time.as_nanos() % duration.as_nanos();
    Some(Duration::new(
        (nanos / 1_000_000_000) as u64,
        (nanos % 1_000_000_000) as u32,
    ))
}

/// One checker per video presentation. All receive the same desired group media
/// time; independent native decoders are not claimed to be frame locked.
pub(crate) struct VideoSync {
    last_check: Instant,
}

impl VideoSync {
    pub(crate) fn new(now: Instant) -> Self {
        Self { last_check: now }
    }

    pub(crate) fn check(
        &mut self,
        now: Instant,
        desired: Duration,
        observed: Duration,
    ) -> Option<Duration> {
        self.correct(now, desired, desired.abs_diff(observed))
    }

    /// Loop wrap must not turn two positions 20 ms apart into a whole-video
    /// seek. The caller supplies the verified media duration, not wall time.
    pub(crate) fn check_looped(
        &mut self,
        now: Instant,
        group_time: Duration,
        observed: Duration,
        duration: Duration,
    ) -> Option<Duration> {
        let desired = looped_video_time(group_time, duration)?;
        let observed = looped_video_time(observed, duration)?;
        let distance = desired.abs_diff(observed);
        self.correct(now, desired, distance.min(duration - distance))
    }

    fn correct(&mut self, now: Instant, desired: Duration, drift: Duration) -> Option<Duration> {
        if now.saturating_duration_since(self.last_check) < VIDEO_SYNC_INTERVAL {
            return None;
        }
        self.last_check = now;
        (drift > VIDEO_SYNC_TOLERANCE).then_some(desired)
    }
}

#[cfg(test)]
mod tests {
    use super::super::config::{Presentation, Selection};
    use super::*;

    fn monitor(
        id: &str,
        left: i32,
        top: i32,
        width: i32,
        height: i32,
        dpi: u32,
        primary: bool,
    ) -> WallpaperMonitor {
        WallpaperMonitor {
            name: format!("GDI-{id}"),
            left,
            top,
            width,
            height,
            dpi,
            primary,
            refresh_hz: if primary { 144 } else { 60 },
            device_path: Some(format!("path-{id}")),
            edid_digest: Some(format!("edid-{id}")),
        }
    }

    fn fixed(monitor: &WallpaperMonitor) -> DisplaySelection {
        DisplaySelection::Fixed {
            display_id: monitor.display_id(),
        }
    }

    fn group(id: &str, mode: LayoutMode, displays: Vec<DisplaySelection>) -> WallpaperGroup {
        WallpaperGroup {
            id: id.into(),
            mode,
            displays,
            selection: Selection::Package {
                work_key: "image".into(),
                package_hash: "a".repeat(64),
            },
            presentation: Presentation::default(),
            properties: Default::default(),
        }
    }

    fn two_monitors() -> Vec<WallpaperMonitor> {
        vec![
            monitor("a", 0, 0, 1920, 1080, 144, true),
            monitor("b", -1080, -300, 1080, 1920, 96, false),
        ]
    }

    #[test]
    fn independent_groups_and_mirror_keep_config_order_and_native_dpi() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![
            group("b", LayoutMode::Single, vec![fixed(&monitors[1])]),
            group("a", LayoutMode::Single, vec![DisplaySelection::Primary]),
        ];
        let mut topology = DisplayTopology::default();
        let plan = topology.reconcile(&groups, &monitors, now).unwrap();
        assert_eq!(
            plan.targets
                .iter()
                .map(|target| target.group_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!((plan.targets[0].dpi, plan.targets[1].dpi), (96, 144));
        assert_eq!(
            plan.targets[0].monitor().display_id(),
            monitors[1].display_id()
        );
        let groups = vec![group(
            "mirror",
            LayoutMode::Mirror,
            vec![fixed(&monitors[1]), fixed(&monitors[0])],
        )];
        let plan = topology.reconcile(&groups, &monitors, now).unwrap();
        assert_eq!(plan.targets.len(), 2);
        assert_eq!(
            plan.targets[0].members[0].display_id,
            monitors[1].display_id()
        );
        assert_eq!(plan.targets[1].members[0].selection_index, 1);
        let reordered = vec![monitors[1].clone(), monitors[0].clone()];
        let next = topology
            .reconcile(&groups, &reordered, now + TOPOLOGY_INTERVAL)
            .unwrap();
        assert_eq!(next.generation, plan.generation);
        assert_eq!(next.targets, plan.targets);
    }

    #[test]
    fn primary_and_fixed_cannot_claim_the_same_actual_screen_in_any_group() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![
            group(
                "primary",
                LayoutMode::Single,
                vec![DisplaySelection::Primary],
            ),
            group("fixed", LayoutMode::Single, vec![fixed(&monitors[0])]),
        ];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics.len(), 2);
        assert!(plan
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.state == DisplayState::Ambiguous
                && diagnostic.reason == "display_claimed_twice"));
        let groups = vec![group(
            "same",
            LayoutMode::Span,
            vec![DisplaySelection::Primary, fixed(&monitors[0])],
        )];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics.len(), 2);
    }

    #[test]
    fn duplicate_identity_is_ambiguous_and_legacy_never_falls_back() {
        let now = Instant::now();
        let mut monitors = two_monitors();
        monitors[1].device_path = monitors[0].device_path.clone();
        monitors[1].edid_digest = monitors[0].edid_digest.clone();
        let groups = vec![group(
            "main",
            LayoutMode::Single,
            vec![DisplaySelection::Primary],
        )];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics[0].state, DisplayState::Ambiguous);
        let groups = vec![group(
            "legacy",
            LayoutMode::Single,
            vec![DisplaySelection::Unresolved {
                legacy_name: monitors[0].name.clone(),
            }],
        )];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors[..1], now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics[0].reason, "unresolved_selection");
    }

    #[test]
    fn span_uses_negative_physical_bounds_rotated_members_and_one_96dpi_canvas() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![group(
            "wide",
            LayoutMode::Span,
            vec![fixed(&monitors[0]), fixed(&monitors[1])],
        )];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert_eq!(plan.targets.len(), 1);
        let target = &plan.targets[0];
        assert_eq!(
            target.bounds,
            PhysicalBounds {
                left: -1080,
                top: -300,
                width: 3000,
                height: 1920
            }
        );
        assert_eq!(target.dpi, 96);
        assert_eq!(target.refresh_hz, 60);
        assert_eq!(target.members[0].dpi, 144);
        assert_eq!(target.members[1].bounds.height, 1920);
        let synthetic = target.monitor();
        assert_eq!(synthetic.display_id(), target.id);
        assert_eq!(
            (synthetic.left, synthetic.width, synthetic.dpi),
            (-1080, 3000, 96)
        );
    }

    #[test]
    fn span_checks_union_pixel_limit_and_coordinate_overflow_without_clamping() {
        let now = Instant::now();
        let monitors = vec![
            monitor("a", -8192, 0, 4096, 2160, 96, true),
            monitor("b", 4096, 0, 4096, 2160, 96, false),
        ];
        let groups = vec![group(
            "wide",
            LayoutMode::Span,
            monitors.iter().map(fixed).collect(),
        )];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics[0].reason, "invalid_span_geometry");
        let invalid = monitor("overflow", i32::MAX - 50, 0, 1920, 1080, 96, true);
        let groups = vec![group("main", LayoutMode::Single, vec![fixed(&invalid)])];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &[invalid], now)
            .unwrap();
        assert!(plan.targets.is_empty());
        assert_eq!(plan.diagnostics[0].reason, "invalid_target_geometry");
    }

    #[test]
    fn span_rejects_unselected_display_coverage_and_its_other_owner_in_either_order() {
        let now = Instant::now();
        let monitors = vec![
            monitor("a", 0, 0, 1920, 1080, 96, true),
            monitor("b", 1920, 0, 1920, 1080, 144, false),
            monitor("c", 3840, 0, 1920, 1080, 96, false),
        ];
        let span = group(
            "span",
            LayoutMode::Span,
            vec![fixed(&monitors[0]), fixed(&monitors[2])],
        );
        let single = group("middle", LayoutMode::Single, vec![fixed(&monitors[1])]);
        for groups in [
            vec![span.clone(), single.clone()],
            vec![single, span.clone()],
        ] {
            let plan = DisplayTopology::default()
                .reconcile(&groups, &monitors, now)
                .unwrap();
            assert!(
                plan.targets.is_empty(),
                "neither owner may present on the middle screen"
            );
            assert!(plan
                .diagnostics
                .iter()
                .any(|item| item.group_id == "span" && item.reason == "invalid_span_geometry"));
            assert!(plan
                .diagnostics
                .iter()
                .any(|item| item.group_id == "middle" && item.reason == "display_claimed_twice"));
        }
        let plan = DisplayTopology::default()
            .reconcile(&[span], &monitors, now)
            .unwrap();
        assert!(
            plan.targets.is_empty(),
            "unassigned connected screens also remain outside the span"
        );
        assert_eq!(plan.diagnostics[0].reason, "invalid_span_geometry");
    }

    #[test]
    fn span_allows_empty_gaps_and_touching_edges_but_rechecks_new_displays() {
        let now = Instant::now();
        let monitors = vec![
            monitor("a", 0, 0, 1920, 1080, 96, true),
            monitor("b", 1920, 0, 1920, 1080, 144, false),
            monitor("c", 3840, 0, 1920, 1080, 96, false),
        ];
        let groups = vec![group(
            "span",
            LayoutMode::Span,
            vec![fixed(&monitors[0]), fixed(&monitors[2])],
        )];
        let mut topology = DisplayTopology::default();
        let plan = topology
            .reconcile(&groups, &[monitors[0].clone(), monitors[2].clone()], now)
            .unwrap();
        assert_eq!(plan.targets.len(), 1, "empty gaps need no ownership");
        let ticket = plan.ticket(&plan.targets[0].id).unwrap();
        let plan = topology
            .reconcile(&groups, &monitors, now + TOPOLOGY_INTERVAL)
            .unwrap();
        assert!(
            plan.targets.is_empty(),
            "a newly connected intermediate screen invalidates the canvas"
        );
        assert!(!topology.accepts(&ticket));

        let groups = vec![
            group(
                "span",
                LayoutMode::Span,
                vec![fixed(&monitors[0]), fixed(&monitors[1])],
            ),
            group("outside", LayoutMode::Single, vec![fixed(&monitors[2])]),
        ];
        let plan = DisplayTopology::default()
            .reconcile(&groups, &monitors, now)
            .unwrap();
        assert!(
            plan.diagnostics.is_empty(),
            "touching the span's edge is not overlap"
        );
        assert_eq!(plan.targets.len(), 2);
        assert_eq!(plan.targets[0].bounds.width, 3840);
        assert_eq!(
            plan.targets[1].members[0].display_id,
            monitors[2].display_id()
        );
    }

    #[test]
    fn retained_span_cannot_keep_a_screen_claimed_after_primary_changes() {
        let now = Instant::now();
        let mut monitors = vec![
            monitor("a", 0, 0, 1920, 1080, 96, true),
            monitor("b", 3840, 0, 1920, 1080, 96, false),
            monitor("c", 1920, 0, 1920, 1080, 96, false),
        ];
        let mut groups = vec![
            group(
                "span",
                LayoutMode::Span,
                vec![DisplaySelection::Primary, fixed(&monitors[2])],
            ),
            group("other", LayoutMode::Single, vec![fixed(&monitors[1])]),
        ];
        let mut topology = DisplayTopology::default();
        let plan = topology.reconcile(&groups, &monitors, now).unwrap();
        assert_eq!(plan.targets.len(), 2);
        let old_span = plan.ticket(&plan.targets[0].id).unwrap();

        // Span intent is unchanged, so missing C would normally retain its old A/C
        // canvas. Primary now resolves to B while the other group explicitly takes A.
        monitors[0].primary = false;
        monitors[1].primary = true;
        monitors.pop();
        groups[1].displays = vec![fixed(&monitors[0])];
        let plan = topology
            .reconcile(&groups, &monitors, now + TOPOLOGY_INTERVAL)
            .unwrap();
        assert!(
            plan.targets.is_empty(),
            "a retained span cannot overlap the newly claimed A target"
        );
        assert!(!topology.accepts(&old_span));
        assert!(plan
            .diagnostics
            .iter()
            .any(|item| item.group_id == "span" && item.reason == "invalid_span_geometry"));
        assert!(plan
            .diagnostics
            .iter()
            .any(|item| item.group_id == "other" && item.reason == "display_claimed_twice"));
    }

    #[test]
    fn prospective_target_limit_counts_mirror_members_even_while_offline() {
        let members: Vec<_> = (0..4)
            .map(|index| DisplaySelection::Fixed {
                display_id: format!("offline-{index}"),
            })
            .collect();
        let mut groups = vec![group("mirror", LayoutMode::Mirror, members.clone())];
        assert_eq!(requested_target_count(&groups).unwrap(), 4);
        groups.push(group(
            "extra",
            LayoutMode::Single,
            vec![DisplaySelection::Primary],
        ));
        let error = DisplayTopology::default()
            .reconcile(&groups, &[], Instant::now())
            .unwrap_err();
        assert_eq!(error.code, "presentation_target_limit");
        groups[0].mode = LayoutMode::Span;
        assert_eq!(requested_target_count(&groups).unwrap(), 2);
        groups.extend((0..3).map(|index| {
            group(
                &format!("more-{index}"),
                LayoutMode::Single,
                vec![DisplaySelection::Primary],
            )
        }));
        assert!(requested_target_count(&groups).is_err());
    }

    #[test]
    fn empty_topology_needs_500ms_and_continuous_rechecks_and_never_claims_missing() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![group("main", LayoutMode::Single, vec![fixed(&monitors[0])])];
        let mut topology = DisplayTopology::default();
        let initial = topology.reconcile(&groups, &monitors, now).unwrap();
        let ticket = initial.ticket(&initial.targets[0].id).unwrap();
        let first = topology
            .reconcile(&groups, &[], now + TOPOLOGY_INTERVAL)
            .unwrap();
        assert!(first.targets[0].retained);
        assert!(!topology.accepts(&ticket));
        assert!(first.ticket(&first.targets[0].id).is_none());
        let second = topology
            .reconcile(&groups, &[], now + Duration::from_millis(500))
            .unwrap();
        assert_eq!(second.targets.len(), 1);
        let expired = topology
            .reconcile(&groups, &[], now + Duration::from_millis(750))
            .unwrap();
        assert!(expired.targets.is_empty());
        assert_eq!(expired.diagnostics[0].reason, "empty_topology");
        assert_eq!(expired.diagnostics[0].state, DisplayState::Waiting);
        let returned = topology
            .reconcile(&groups, &monitors, now + Duration::from_secs(1))
            .unwrap();
        assert!(returned.diagnostics.is_empty());
        assert_eq!(returned.targets[0].id, initial.targets[0].id);
        assert!(returned.generation > expired.generation);
    }

    #[test]
    fn absent_display_requires_three_nonempty_hits_and_recovery_rejects_old_tickets() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![group("main", LayoutMode::Single, vec![fixed(&monitors[0])])];
        let mut topology = DisplayTopology::default();
        let first = topology.reconcile(&groups, &monitors, now).unwrap();
        let ticket = first.ticket(&first.targets[0].id).unwrap();
        for millis in [250, 251, 252, 500] {
            let plan = topology
                .reconcile(&groups, &monitors[1..], now + Duration::from_millis(millis))
                .unwrap();
            assert!(plan.targets[0].retained);
            assert_eq!(plan.diagnostics[0].state, DisplayState::Waiting);
        }
        let missing = topology
            .reconcile(&groups, &monitors[1..], now + Duration::from_millis(750))
            .unwrap();
        assert!(missing.targets.is_empty());
        assert_eq!(missing.diagnostics[0].state, DisplayState::Missing);
        let returned = topology
            .reconcile(&groups, &monitors, now + Duration::from_secs(1))
            .unwrap();
        assert_eq!(returned.targets, first.targets);
        assert!(returned.generation > missing.generation);
        assert!(!topology.accepts(&ticket));
        assert!(topology.accepts(&returned.ticket(&returned.targets[0].id).unwrap()));
    }

    #[test]
    fn empty_enumeration_breaks_nonempty_absence_streak_and_config_retarget_cannot_retain() {
        let now = Instant::now();
        let monitors = two_monitors();
        let mut groups = vec![group("main", LayoutMode::Single, vec![fixed(&monitors[0])])];
        let mut topology = DisplayTopology::default();
        topology.reconcile(&groups, &monitors, now).unwrap();
        topology
            .reconcile(&groups, &monitors[1..], now + Duration::from_millis(250))
            .unwrap();
        topology
            .reconcile(&groups, &[], now + Duration::from_millis(500))
            .unwrap();
        for millis in [750, 1000] {
            let plan = topology
                .reconcile(&groups, &monitors[1..], now + Duration::from_millis(millis))
                .unwrap();
            assert_eq!(plan.diagnostics[0].state, DisplayState::Waiting);
        }
        groups[0].displays = vec![DisplaySelection::Fixed {
            display_id: "other".into(),
        }];
        let plan = topology
            .reconcile(&groups, &[], now + Duration::from_millis(1250))
            .unwrap();
        assert!(plan.targets.is_empty());
    }

    #[test]
    fn span_never_shrinks_to_surviving_member_during_absence() {
        let now = Instant::now();
        let monitors = two_monitors();
        let groups = vec![group(
            "span",
            LayoutMode::Span,
            monitors.iter().map(fixed).collect(),
        )];
        let mut topology = DisplayTopology::default();
        let full = topology.reconcile(&groups, &monitors, now).unwrap();
        for millis in [250, 500] {
            let waiting = topology
                .reconcile(&groups, &monitors[1..], now + Duration::from_millis(millis))
                .unwrap();
            assert_eq!(waiting.targets[0].bounds, full.targets[0].bounds);
            assert_eq!(waiting.targets[0].members.len(), 2);
            assert!(waiting.targets[0].retained);
        }
        let missing = topology
            .reconcile(&groups, &monitors[1..], now + Duration::from_millis(750))
            .unwrap();
        assert!(missing.targets.is_empty());
    }

    #[test]
    fn each_mirror_member_keeps_its_own_absence_grace() {
        let now = Instant::now();
        let mut monitors = two_monitors();
        monitors.push(monitor("c", 1920, 0, 1280, 720, 96, false));
        let groups = vec![group(
            "mirror",
            LayoutMode::Mirror,
            vec![fixed(&monitors[0]), fixed(&monitors[1])],
        )];
        let mut topology = DisplayTopology::default();
        topology.reconcile(&groups, &monitors, now).unwrap();
        for millis in [250, 500] {
            topology
                .reconcile(&groups, &monitors[1..], now + Duration::from_millis(millis))
                .unwrap();
        }
        // A reaches missing exactly when B starts its own grace. A must neither
        // discard B's surface nor reorder B into the first configured member.
        let plan = topology
            .reconcile(&groups, &monitors[2..], now + Duration::from_millis(750))
            .unwrap();
        assert_eq!(plan.targets.len(), 1);
        assert!(plan.targets[0].retained);
        assert_eq!(plan.targets[0].members[0].selection_index, 1);
        assert_eq!(plan.diagnostics[0].state, DisplayState::Missing);
        assert_eq!(plan.diagnostics[1].state, DisplayState::Waiting);
        let resumed = topology
            .reconcile(&groups, &monitors, now + Duration::from_secs(1))
            .unwrap();
        assert_eq!(resumed.targets[0].members[0].selection_index, 0);
        assert_eq!(resumed.targets[1].members[0].selection_index, 1);
    }

    #[test]
    fn primary_change_and_resize_each_invalidate_outstanding_receipts() {
        let now = Instant::now();
        let mut monitors = two_monitors();
        let groups = vec![group(
            "main",
            LayoutMode::Single,
            vec![DisplaySelection::Primary],
        )];
        let mut topology = DisplayTopology::default();
        let first = topology.reconcile(&groups, &monitors, now).unwrap();
        let ticket = first.ticket(&first.targets[0].id).unwrap();
        monitors[0].width = 2000;
        let resized = topology
            .reconcile(&groups, &monitors, now + TOPOLOGY_INTERVAL)
            .unwrap();
        assert!(!topology.accepts(&ticket));
        let resized_ticket = resized.ticket(&resized.targets[0].id).unwrap();
        monitors[0].primary = false;
        monitors[1].primary = true;
        let switched = topology
            .reconcile(&groups, &monitors, now + Duration::from_millis(500))
            .unwrap();
        assert!(!topology.accepts(&resized_ticket));
        assert_ne!(first.targets[0].id, switched.targets[0].id);
    }

    #[test]
    fn group_clock_partial_pause_resumes_at_current_time_without_hidden_dt() {
        let now = Instant::now();
        let mut clock = GroupClock::new(["b".into(), "a".into()], now).unwrap();
        clock.set_running("a", true, now).unwrap();
        clock.set_running("b", true, now).unwrap();
        assert_eq!(clock.sample("a", now).unwrap().dt, Duration::ZERO);
        clock
            .set_running("a", false, now + Duration::from_secs(1))
            .unwrap();
        assert!(clock.sample("a", now + Duration::from_secs(3)).is_none());
        assert_eq!(
            clock
                .sample("b", now + Duration::from_secs(3))
                .unwrap()
                .time,
            Duration::from_secs(3)
        );
        clock
            .set_running("a", true, now + Duration::from_secs(5))
            .unwrap();
        let resumed = clock.sample("a", now + Duration::from_secs(5)).unwrap();
        assert_eq!(
            resumed,
            ClockSample {
                time: Duration::from_secs(5),
                dt: Duration::ZERO
            }
        );
        assert_eq!(
            clock
                .sample("a", now + Duration::from_millis(5016))
                .unwrap()
                .dt,
            Duration::from_millis(16)
        );
        assert_eq!(clock.member_ids().collect::<Vec<_>>(), vec!["b", "a"]);
    }

    #[test]
    fn group_clock_freezes_only_when_every_member_pauses() {
        let now = Instant::now();
        let mut clock = GroupClock::new(["a".into(), "b".into()], now).unwrap();
        clock.set_running("a", true, now).unwrap();
        clock.set_running("b", true, now).unwrap();
        clock
            .set_running("a", false, now + Duration::from_secs(1))
            .unwrap();
        clock
            .set_running("b", false, now + Duration::from_secs(2))
            .unwrap();
        assert_eq!(
            clock.time(now + Duration::from_secs(30)),
            Duration::from_secs(2)
        );
        clock
            .set_running("a", true, now + Duration::from_secs(31))
            .unwrap();
        assert_eq!(
            clock.sample("a", now + Duration::from_secs(31)).unwrap(),
            ClockSample {
                time: Duration::from_secs(2),
                dt: Duration::ZERO
            }
        );
        assert_eq!(
            clock
                .sample("a", now + Duration::from_secs(32))
                .unwrap()
                .time,
            Duration::from_secs(3)
        );
        assert!(clock
            .set_running("unknown", true, now + Duration::from_secs(32))
            .is_err());
        assert!(clock.set_running("a", false, now).is_err());
    }

    #[test]
    fn mirror_requires_absolute_reconstruction_and_does_not_certify_current_builtins() {
        let mut group = group(
            "mirror",
            LayoutMode::Mirror,
            vec![DisplaySelection::Primary],
        );
        assert!(validate_mirror(&group, MirrorEligibility::image()).is_ok());
        assert!(validate_mirror(&group, MirrorEligibility::video()).is_ok());
        assert!(validate_mirror(
            &group,
            MirrorEligibility {
                time_model: TimeModel::Absolute,
                reconstructable: false
            }
        )
        .is_err());
        assert!(validate_mirror(&group, MirrorEligibility::builtin("zodiac")).is_err());
        group.mode = LayoutMode::Span;
        assert!(validate_mirror(&group, MirrorEligibility::builtin("zodiac")).is_ok());
        group.mode = LayoutMode::Single;
        assert!(validate_mirror(&group, MirrorEligibility::builtin("zodiac")).is_ok());
    }

    #[test]
    fn video_correction_obeys_two_second_cadence_and_strict_100ms_threshold() {
        let now = Instant::now();
        let mut sync = VideoSync::new(now);
        let desired = Duration::from_secs(12);
        assert_eq!(
            sync.check(now + Duration::from_millis(1999), desired, Duration::ZERO),
            None
        );
        assert_eq!(
            sync.check(
                now + Duration::from_secs(2),
                desired,
                desired - VIDEO_SYNC_TOLERANCE
            ),
            None
        );
        assert_eq!(
            sync.check(now + Duration::from_secs(3), desired, Duration::ZERO),
            None
        );
        assert_eq!(
            sync.check(
                now + Duration::from_secs(4),
                desired,
                desired - Duration::from_millis(101)
            ),
            Some(desired)
        );
        assert_eq!(
            sync.check(
                now + Duration::from_secs(6),
                desired,
                desired + Duration::from_millis(101)
            ),
            Some(desired)
        );
        assert_eq!(
            looped_video_time(Duration::from_millis(12345), Duration::from_secs(5)),
            Some(Duration::from_millis(2345))
        );
        assert_eq!(looped_video_time(desired, Duration::ZERO), None);
    }

    #[test]
    fn video_loop_boundary_uses_circular_distance_and_shared_group_phase() {
        let now = Instant::now();
        let duration = Duration::from_secs(10);
        let desired = Duration::from_millis(30010);
        let mut near = VideoSync::new(now);
        let mut late = VideoSync::new(now);
        assert_eq!(
            near.check_looped(
                now + VIDEO_SYNC_INTERVAL,
                desired,
                Duration::from_millis(9990),
                duration,
            ),
            None,
        );
        assert_eq!(
            late.check_looped(
                now + VIDEO_SYNC_INTERVAL,
                desired,
                Duration::from_millis(9800),
                duration,
            ),
            Some(Duration::from_millis(10)),
        );
        assert_eq!(
            late.check_looped(
                now + VIDEO_SYNC_INTERVAL * 2,
                desired,
                Duration::ZERO,
                Duration::ZERO,
            ),
            None,
        );
    }
}
