// SPDX-License-Identifier: MIT
//! Derived skin associations on the original numeric jobs and decoded values.

use std::mem::size_of;

use super::{invalid, Job};
use crate::{model_structure::ModelStructure, PackageError, Result};

pub const MAX_MODEL_SKIN_ASSOCIATION_BYTES: u64 = 16_777_216;
pub const MAX_MODEL_SKIN_ASSOCIATION_WORK: u64 = 67_108_864;
const EMPTY: u8 = 255;
const JOINT: u8 = 1;
const WEIGHT: u8 = 2;
const ACTIVE: u8 = 4;
const ALL_INTEGER: u32 = 1;
const FLOAT_WEIGHTS: u32 = 1;
const JOINT_NAMES: [&str; 15] = [
    "JOINTS_0",
    "JOINTS_1",
    "JOINTS_2",
    "JOINTS_3",
    "JOINTS_4",
    "JOINTS_5",
    "JOINTS_6",
    "JOINTS_7",
    "JOINTS_8",
    "JOINTS_9",
    "JOINTS_10",
    "JOINTS_11",
    "JOINTS_12",
    "JOINTS_13",
    "JOINTS_14",
];
const WEIGHT_NAMES: [&str; 15] = [
    "WEIGHTS_0",
    "WEIGHTS_1",
    "WEIGHTS_2",
    "WEIGHTS_3",
    "WEIGHTS_4",
    "WEIGHTS_5",
    "WEIGHTS_6",
    "WEIGHTS_7",
    "WEIGHTS_8",
    "WEIGHTS_9",
    "WEIGHTS_10",
    "WEIGHTS_11",
    "WEIGHTS_12",
    "WEIGHTS_13",
    "WEIGHTS_14",
];

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Slot {
    joint: u16,
    flags: u8,
    next_active: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct VertexHeader {
    sum: u32,
    weight_seen: u8,
    completed: u8,
    active_head: u8,
    reserved: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Group {
    vertex_count: u32,
    first_set: u32,
    set_count: u32,
    first_slot: u32,
    first_header: u32,
    flags: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Set {
    joint_job: u32,
    weight_job: u32,
    joint_type: u32,
    weight_type: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Observer {
    group: u32,
    set: u16,
    role: u8,
    reserved: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SkinJob {
    first_observer: u32,
    observer_count: u32,
    joint_bound: u32,
    ibm_prefix: u32,
    flags: u32,
    reserved: u32,
}

const _: () = {
    assert!(size_of::<Slot>() == 4);
    assert!(size_of::<VertexHeader>() == 8);
    assert!(size_of::<Group>() == 24);
    assert!(size_of::<Set>() == 16);
    assert!(size_of::<Observer>() == 8);
    assert!(size_of::<SkinJob>() == 24);
};

pub(super) struct SkinValidation {
    groups: Vec<Group>,
    sets: Vec<Set>,
    observers: Vec<Observer>,
    jobs: Vec<SkinJob>,
    slots: Vec<Slot>,
    headers: Vec<VertexHeader>,
    // Each vertex decrements once, after both roles have completed every slot.
    // Duplicate arrivals fail first; finish therefore needs no second arena scan.
    remaining_vertices: u64,
}

fn state_limit() -> PackageError {
    PackageError::new(
        "model_binary_limit",
        "skin association state exceeds the bounded byte limit",
    )
}
fn work_limit() -> PackageError {
    PackageError::new(
        "model_binary_limit",
        "skin association work exceeds the bounded operation limit",
    )
}
fn internal() -> PackageError {
    invalid("skin association received inconsistent checked structure or duplicate role")
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(work_limit)
}
fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(work_limit)
}
fn choose2(n: u64) -> Result<u64> {
    let previous = n.saturating_sub(1);
    if n % 2 == 0 {
        mul(n / 2, previous)
    } else {
        mul(n, previous / 2)
    }
}
fn narrow(n: u64) -> Result<u32> {
    u32::try_from(n).map_err(|_| state_limit())
}
fn length(n: u64) -> Result<usize> {
    usize::try_from(n).map_err(|_| state_limit())
}
fn allocate<T: Clone + Default>(capacity: u64, initialized: u64) -> Result<Vec<T>> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(length(capacity)?)
        .map_err(|_| state_limit())?;
    result.resize(length(initialized)?, T::default());
    Ok(result)
}
fn payload<T>(values: &Vec<T>) -> Result<u64> {
    (values.capacity() as u64)
        .checked_mul(size_of::<T>() as u64)
        .ok_or_else(state_limit)
}
fn metadata_bytes(e: u64, p: u64, j: u64) -> Result<u64> {
    e.checked_mul(24)
        .and_then(|n| p.checked_mul(32).and_then(|p| n.checked_add(p)))
        .and_then(|n| j.checked_mul(24).and_then(|j| n.checked_add(j)))
        .ok_or_else(state_limit)
}
fn metadata_work(e: u64, p: u64, j: u64, i: u64, q: u64, max_sets: u64) -> Result<u64> {
    add(
        add(
            add(
                add(mul(choose2(e)?, add(3, mul(4, max_sets)?)?)?, mul(2, p)?)?,
                i,
            )?,
            j,
        )?,
        q,
    )
}
fn group_work(sets: u64) -> Result<u64> {
    let slots = mul(sets, 4)?;
    add(add(add(mul(10, sets)?, slots)?, 1)?, choose2(slots)?)
}

pub(super) fn prepare(
    structure: &ModelStructure,
    mapping: &[usize],
    raw_jobs: &[Job],
    raw_elements: u64,
) -> Result<Option<SkinValidation>> {
    let mut e = 0_u64;
    let mut p = 0_u64;
    let mut max_sets = 0;
    for mesh in &structure.meshes {
        for primitive in &mesh.primitives {
            let count = primitive
                .attributes
                .keys()
                .filter(|name| name.starts_with("JOINTS_"))
                .count() as u64;
            if count != 0 {
                e = add(e, 1)?;
                p = add(p, count)?;
                max_sets = max_sets.max(count);
            }
        }
    }
    let i = structure
        .skins
        .iter()
        .filter(|skin| skin.inverse_bind_matrices.is_some())
        .count() as u64;
    if p == 0 && i == 0 {
        return Ok(None);
    }
    if max_sets > 15 {
        return Err(internal());
    }
    let j = raw_jobs.len() as u64;
    let mut work = metadata_work(e, p, j, i, structure.skin_binding_pair_refs, max_sets)?;
    if work > MAX_MODEL_SKIN_ASSOCIATION_WORK {
        return Err(work_limit());
    }
    if metadata_bytes(e, p, j)? > MAX_MODEL_SKIN_ASSOCIATION_BYTES {
        return Err(state_limit());
    }
    let mut validation = SkinValidation {
        groups: allocate(e, 0)?,
        sets: allocate(p, 0)?,
        observers: allocate(mul(2, p)?, mul(2, p)?)?,
        jobs: allocate(j, j)?,
        slots: Vec::new(),
        headers: Vec::new(),
        remaining_vertices: 0,
    };
    let mut bytes = add(
        add(payload(&validation.groups)?, payload(&validation.sets)?)?,
        add(payload(&validation.observers)?, payload(&validation.jobs)?)?,
    )?;
    if bytes > MAX_MODEL_SKIN_ASSOCIATION_BYTES {
        return Err(state_limit());
    }
    for mesh in &structure.meshes {
        for primitive in &mesh.primitives {
            let count = primitive
                .attributes
                .keys()
                .filter(|name| name.starts_with("JOINTS_"))
                .count();
            if count == 0 {
                continue;
            }
            let mut candidate = [Set::default(); 15];
            let mut flags = ALL_INTEGER;
            for set in 0..count {
                let joint = primitive.attributes[JOINT_NAMES[set]];
                let weight = primitive.attributes[WEIGHT_NAMES[set]];
                candidate[set] = Set {
                    joint_job: narrow(mapping[joint] as u64)?,
                    weight_job: narrow(mapping[weight] as u64)?,
                    joint_type: structure.accessors[joint].component_type,
                    weight_type: structure.accessors[weight].component_type,
                };
                if candidate[set].weight_type == 5126 {
                    flags = 0;
                }
            }
            let vertex_count = narrow(structure.accessors[primitive.attributes["POSITION"]].count)?;
            let duplicate = validation.groups.iter().any(|group| {
                group.vertex_count == vertex_count
                    && group.set_count as usize == count
                    && group.flags == flags
                    && validation.sets[group.first_set as usize..group.first_set as usize + count]
                        == candidate[..count]
            });
            if duplicate {
                continue;
            }
            let first_set = narrow(validation.sets.len() as u64)?;
            validation.sets.extend_from_slice(&candidate[..count]);
            validation.groups.push(Group {
                vertex_count,
                first_set,
                set_count: count as u32,
                flags,
                ..Group::default()
            });
        }
    }
    // Bounds merge every actual author consumer. Q includes repeated bindings.
    for binding in &structure.skin_bindings {
        let primitive = &structure.meshes[binding.mesh].primitives[binding.primitive];
        let bound = narrow(structure.skins[binding.skin].joints.len() as u64)?;
        for name in JOINT_NAMES {
            if let Some(&accessor) = primitive.attributes.get(name) {
                let job = &mut validation.jobs[mapping[accessor]];
                job.joint_bound = if job.joint_bound == 0 {
                    bound
                } else {
                    job.joint_bound.min(bound)
                };
            } else {
                break;
            }
        }
    }
    for skin in &structure.skins {
        if let Some(accessor) = skin.inverse_bind_matrices {
            let job = &mut validation.jobs[mapping[accessor]];
            job.ibm_prefix = job.ibm_prefix.max(narrow(skin.joints.len() as u64)?);
        }
    }
    for group in &validation.groups {
        for set in &validation.sets
            [group.first_set as usize..group.first_set as usize + group.set_count as usize]
        {
            for job in [set.joint_job, set.weight_job] {
                let job = &mut validation.jobs[job as usize];
                job.observer_count = job.observer_count.checked_add(1).ok_or_else(state_limit)?;
            }
            if set.weight_type == 5126 {
                validation.jobs[set.weight_job as usize].flags |= FLOAT_WEIGHTS;
            }
        }
    }
    let mut observer_offset = 0_u32;
    for job in &mut validation.jobs {
        job.first_observer = observer_offset;
        observer_offset = observer_offset
            .checked_add(job.observer_count)
            .ok_or_else(state_limit)?;
    }
    if observer_offset as usize > validation.observers.len() {
        return Err(internal());
    }
    for (index, group) in validation.groups.iter().enumerate() {
        for (set_index, set) in validation.sets
            [group.first_set as usize..group.first_set as usize + group.set_count as usize]
            .iter()
            .enumerate()
        {
            for (job, role) in [(set.joint_job, JOINT), (set.weight_job, WEIGHT)] {
                let job = &mut validation.jobs[job as usize];
                let offset = job
                    .first_observer
                    .checked_add(job.reserved)
                    .ok_or_else(state_limit)?;
                validation.observers[offset as usize] = Observer {
                    group: narrow(index as u64)?,
                    set: u16::try_from(set_index).map_err(|_| state_limit())?,
                    role,
                    reserved: 0,
                };
                job.reserved = job.reserved.checked_add(1).ok_or_else(state_limit)?;
            }
        }
    }
    work = add(work, raw_elements)?;
    for (index, job) in validation.jobs.iter_mut().enumerate() {
        if job.reserved != job.observer_count {
            return Err(internal());
        }
        job.reserved = 0;
        let count = structure.accessors[raw_jobs[index].accessor].count;
        if job.joint_bound != 0 {
            work = add(work, mul(4, count)?)?;
        }
        if job.flags & FLOAT_WEIGHTS != 0 {
            work = add(work, mul(4, count)?)?;
        }
        work = add(work, mul(4, u64::from(job.ibm_prefix))?)?;
    }
    let mut slots = 0_u64;
    let mut vertices = 0_u64;
    for group in &mut validation.groups {
        group.first_slot = narrow(slots)?;
        group.first_header = narrow(vertices)?;
        let v = u64::from(group.vertex_count);
        let l = mul(4, u64::from(group.set_count))?;
        slots = add(slots, mul(v, l)?)?;
        vertices = add(vertices, v)?;
        bytes = add(bytes, mul(v, add(mul(l, 4)?, 8)?)?)?;
        work = add(work, mul(v, group_work(u64::from(group.set_count))?)?)?;
    }
    if bytes > MAX_MODEL_SKIN_ASSOCIATION_BYTES {
        return Err(state_limit());
    }
    if work > MAX_MODEL_SKIN_ASSOCIATION_WORK {
        return Err(work_limit());
    }
    validation.slots = allocate(slots, slots)?;
    validation.headers = allocate(vertices, vertices)?;
    for header in &mut validation.headers {
        header.active_head = EMPTY;
    }
    validation.remaining_vertices = vertices;
    let actual_bytes = add(
        add(
            add(payload(&validation.groups)?, payload(&validation.sets)?)?,
            add(payload(&validation.observers)?, payload(&validation.jobs)?)?,
        )?,
        add(payload(&validation.slots)?, payload(&validation.headers)?)?,
    )?;
    if actual_bytes > MAX_MODEL_SKIN_ASSOCIATION_BYTES {
        return Err(state_limit());
    }
    Ok(Some(validation))
}

impl SkinValidation {
    pub(super) fn observe(
        &mut self,
        job: usize,
        element: u64,
        component_type: u32,
        values: &[f64; 16],
    ) -> Result<()> {
        let fact = *self.jobs.get(job).ok_or_else(internal)?;
        if fact.joint_bound != 0
            && values[..4]
                .iter()
                .any(|&value| value >= f64::from(fact.joint_bound))
        {
            return Err(invalid(
                "JOINTS component exceeds an actual skin consumer's joint count",
            ));
        }
        if fact.flags & FLOAT_WEIGHTS != 0 && values[..4].iter().any(|&value| value < 0.) {
            return Err(invalid("FLOAT WEIGHTS components must be nonnegative"));
        }
        if element < u64::from(fact.ibm_prefix)
            && [values[3], values[7], values[11], values[15]] != [0., 0., 0., 1.]
        {
            return Err(invalid(
                "skin inverse bind matrix prefix must have affine fourth rows",
            ));
        }
        let end = fact
            .first_observer
            .checked_add(fact.observer_count)
            .ok_or_else(internal)?;
        for offset in fact.first_observer..end {
            let observer = self.observers[offset as usize];
            let group = self.groups[observer.group as usize];
            if element >= u64::from(group.vertex_count) {
                return Err(internal());
            }
            let l = group.set_count.checked_mul(4).ok_or_else(internal)?;
            let base = u64::from(group.first_slot)
                .checked_add(element.checked_mul(u64::from(l)).ok_or_else(internal)?)
                .ok_or_else(internal)?;
            let base = usize::try_from(base).map_err(|_| internal())?;
            let header_index = u64::from(group.first_header)
                .checked_add(element)
                .ok_or_else(internal)?;
            let header = self
                .headers
                .get_mut(usize::try_from(header_index).map_err(|_| internal())?)
                .ok_or_else(internal)?;
            for (component, &value) in values[..4].iter().enumerate() {
                let local = usize::from(observer.set)
                    .checked_mul(4)
                    .and_then(|n| n.checked_add(component))
                    .ok_or_else(internal)?;
                let index = base.checked_add(local).ok_or_else(internal)?;
                let slot = self.slots.get_mut(index).ok_or_else(internal)?;
                if slot.flags & observer.role != 0 {
                    return Err(internal());
                }
                slot.flags |= observer.role;
                if observer.role == JOINT {
                    slot.joint = u16::try_from(value as u64).map_err(|_| internal())?;
                } else {
                    header.weight_seen = header.weight_seen.checked_add(1).ok_or_else(internal)?;
                    if value != 0. {
                        slot.flags |= ACTIVE;
                    }
                    if group.flags & ALL_INTEGER != 0 {
                        let scaled = match component_type {
                            5121 => (value as u32).checked_mul(257).ok_or_else(internal)?,
                            5123 => value as u32,
                            _ => return Err(internal()),
                        };
                        header.sum = header.sum.checked_add(scaled).ok_or_else(internal)?;
                    }
                }
                if slot.flags & (JOINT | WEIGHT) != (JOINT | WEIGHT) {
                    continue;
                }
                header.completed = header.completed.checked_add(1).ok_or_else(internal)?;
                if u32::from(header.completed) > l {
                    return Err(internal());
                }
                if slot.flags & ACTIVE != 0 {
                    let joint = slot.joint;
                    let mut active = header.active_head;
                    while active != EMPTY {
                        if u32::from(active) >= l {
                            return Err(internal());
                        }
                        let previous = self
                            .slots
                            .get(base.checked_add(usize::from(active)).ok_or_else(internal)?)
                            .ok_or_else(internal)?;
                        if previous.joint == joint {
                            return Err(invalid("nonzero skin weights associate the same joint more than once per vertex"));
                        }
                        active = previous.next_active;
                    }
                    self.slots[index].next_active = header.active_head;
                    header.active_head = u8::try_from(local).map_err(|_| internal())?;
                }
                if u32::from(header.completed) == l {
                    if u32::from(header.weight_seen) != l {
                        return Err(internal());
                    }
                    if group.flags & ALL_INTEGER != 0 && header.sum != 65_535 {
                        return Err(invalid(
                            "integer skin weights across all sets must sum exactly to 65535",
                        ));
                    }
                    self.remaining_vertices = self
                        .remaining_vertices
                        .checked_sub(1)
                        .ok_or_else(internal)?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn finish(&self) -> Result<()> {
        if self.remaining_vertices != 0 {
            return Err(invalid(
                "skin association roles did not complete every vertex",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layouts_capacity_and_exact_default_admissions() {
        assert_eq!(
            [
                size_of::<Slot>(),
                size_of::<VertexHeader>(),
                size_of::<Group>(),
                size_of::<Set>(),
                size_of::<Observer>(),
                size_of::<SkinJob>()
            ],
            [4, 8, 24, 16, 8, 24]
        );
        assert_eq!(
            size_of::<SkinValidation>(),
            6 * size_of::<Vec<u8>>() + size_of::<u64>()
        );
        assert_eq!(size_of::<[Set; 15]>(), 240);
        let groups = allocate::<Group>(2, 0).unwrap();
        let sets = allocate::<Set>(3, 0).unwrap();
        let observers = allocate::<Observer>(6, 6).unwrap();
        let jobs = allocate::<SkinJob>(9, 9).unwrap();
        assert_eq!(
            payload(&groups).unwrap()
                + payload(&sets).unwrap()
                + payload(&observers).unwrap()
                + payload(&jobs).unwrap(),
            360
        );
        assert_eq!(
            metadata_bytes(2, 3, 9).unwrap() + 24 * 699_034 + 40,
            MAX_MODEL_SKIN_ASSOCIATION_BYTES
        );
        assert_eq!(metadata_work(3, 20, 44, 0, 20, 15).unwrap(), 293);
        assert_eq!(
            2072 * 32_387 + 128 * 8 + 70 * 24 + 296,
            MAX_MODEL_SKIN_ASSOCIATION_WORK
        );
        assert_eq!(
            [
                group_work(15).unwrap() + 31 + 60,
                group_work(3).unwrap() + 7 + 12,
                group_work(2).unwrap() + 5 + 8
            ],
            [2072, 128, 70]
        );
        assert!(choose2(u64::MAX).is_err());
        assert!(metadata_bytes(u64::MAX, 0, 0).is_err());
        assert!(narrow(u64::MAX).is_err());
        assert!(allocate::<Slot>(u64::MAX, 0).is_err());
    }
}
