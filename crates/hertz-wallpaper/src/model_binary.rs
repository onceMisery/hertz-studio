// SPDX-License-Identifier: MIT
//! Static, morph delta and FLOAT animation values checked on one bounded GLB
//! stream. This does not qualify normalized animation precision, image codecs,
//! resource preparation, animation playback, loaders or the GPU.

use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap},
    io::{self, Read},
};

use sha2::{Digest, Sha256};

use crate::{
    manifest::Manifest,
    model_container::inspect_glb_with,
    model_structure::{
        component_precision, structure_from_container, AnimationInterpolation, AnimationPath,
        GlbResource, ModelAccessor, ModelStructure,
    },
    resource_container_io::ContainerReader,
    PackageError, Result,
};

pub const MAX_MODEL_VALIDATION_ELEMENTS: u64 = 16_777_216;
pub const MAX_MODEL_VALIDATION_COMPONENTS: u64 = 67_108_864;
const WINDOW_BYTES: usize = 64 * 1024;
/// Numeric tolerance for this static subset; vectors are never rewritten.
const UNIT_LENGTH_SQUARED_TOLERANCE: f64 = 1e-4;

/// Only the inspector can construct these facts. The digest covers the exact
/// entire GLB stream whose values were checked, including unused BIN bytes.
/// It does not attest to the caller's Manifest or transitive image content.
#[derive(Debug, Clone)]
pub struct CheckedGlbResource {
    resource: GlbResource,
    sha256: [u8; 32],
    bytes: u64,
    source_path: String,
    facts: NumericFacts,
}

impl CheckedGlbResource {
    pub fn resource(&self) -> &GlbResource {
        &self.resource
    }
    pub fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }
    pub fn sha256_hex(&self) -> String {
        format!("{:x}", sha2::digest::Output::<Sha256>::from(self.sha256))
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn source_path(&self) -> &str {
        &self.source_path
    }
    pub fn checked_accessors(&self) -> usize {
        self.resource.structure.accessors.len()
    }
    pub fn unique_layouts(&self) -> usize {
        self.facts.unique_layouts
    }
    pub fn checked_elements(&self) -> u64 {
        self.facts.elements
    }
    pub fn checked_components(&self) -> u64 {
        self.facts.components
    }
}

pub fn inspect_glb_resource_content<R: Read>(
    input: R,
    declared_bytes: u64,
    manifest: &Manifest,
    path: &str,
) -> Result<CheckedGlbResource> {
    crate::paths::validate_rel_path(path)?;
    let mut hashing = HashingReader {
        input,
        hash: Sha256::new(),
        bytes: 0,
    };
    let (container, (structure, facts)) =
        inspect_glb_with(&mut hashing, declared_bytes, |container, reader| {
            let structure = structure_from_container(container, manifest, path)?;
            let facts = inspect_accessors(&structure, reader)?;
            Ok((structure, facts))
        })?;
    Ok(CheckedGlbResource {
        resource: GlbResource {
            container,
            structure,
        },
        sha256: hashing.hash.finalize().into(),
        bytes: hashing.bytes,
        source_path: path.to_owned(),
        facts,
    })
}

struct HashingReader<R> {
    input: R,
    hash: Sha256,
    bytes: u64,
}
impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self.input.read(output)?;
        self.hash.update(&output[..count]);
        self.bytes += count as u64;
        Ok(count)
    }
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::new("invalid_model_binary", message)
}
fn limit() -> PackageError {
    PackageError::new(
        "model_binary_limit",
        "unique accessor layouts exceed the bounded numeric validation work",
    )
}

#[derive(Debug, Clone, Copy)]
struct NumericFacts {
    unique_layouts: usize,
    elements: u64,
    components: u64,
}
struct Job {
    accessor: usize,
    min: [f64; 16],
    max: [f64; 16],
    index_bound: Option<u64>,
    normal: bool,
    tangent: bool,
    color_zero: bool,
    timestamps: bool,
    previous_time: Option<f64>,
    rotation_all: bool,
    rotation_cubic_values: bool,
}

fn inspect_accessors<R: Read>(
    structure: &ModelStructure,
    reader: &mut ContainerReader<R>,
) -> Result<NumericFacts> {
    let mut layouts = BTreeMap::new();
    let mut jobs = Vec::<Job>::new();
    let mut mapping = Vec::with_capacity(structure.accessors.len());
    let mut elements = 0_u64;
    let mut components = 0_u64;
    for (index, accessor) in structure.accessors.iter().enumerate() {
        // normalized/bounds affect interpretation, not raw component decoding.
        let key = (
            accessor.range.offset,
            accessor.count,
            accessor.stride,
            accessor.component_type,
            accessor.shape as u8,
        );
        let job = if let Some(&job) = layouts.get(&key) {
            job
        } else {
            let (columns, rows) = accessor.shape.dimensions();
            elements = elements.checked_add(accessor.count).ok_or_else(limit)?;
            components = components
                .checked_add(
                    accessor
                        .count
                        .checked_mul(columns * rows)
                        .ok_or_else(limit)?,
                )
                .ok_or_else(limit)?;
            if elements > MAX_MODEL_VALIDATION_ELEMENTS
                || components > MAX_MODEL_VALIDATION_COMPONENTS
            {
                return Err(limit());
            }
            let job = jobs.len();
            jobs.push(Job {
                accessor: index,
                min: [f64::INFINITY; 16],
                max: [f64::NEG_INFINITY; 16],
                index_bound: None,
                normal: false,
                tangent: false,
                color_zero: false,
                timestamps: false,
                previous_time: None,
                rotation_all: false,
                rotation_cubic_values: false,
            });
            layouts.insert(key, job);
            job
        };
        mapping.push(job);
    }
    for mesh in &structure.meshes {
        for primitive in &mesh.primitives {
            if let Some(index) = primitive.indices {
                let vertex_count = structure.accessors[primitive.attributes["POSITION"]].count;
                let job = &mut jobs[mapping[index]];
                job.index_bound = Some(
                    job.index_bound
                        .map_or(vertex_count, |old| old.min(vertex_count)),
                );
            }
            for (semantic, &index) in &primitive.attributes {
                // Only actual base attributes acquire these value roles. Morph
                // deltas are already scanned through the unique accessor jobs.
                let job = &mut jobs[mapping[index]];
                job.normal |= semantic == "NORMAL";
                job.tangent |= semantic == "TANGENT";
                job.color_zero |= semantic == "COLOR_0";
            }
        }
    }
    for animation in &structure.animations {
        for sampler in &animation.samplers {
            jobs[mapping[sampler.input]].timestamps = true;
        }
        for channel in &animation.channels {
            if channel.target_node.is_some() && channel.path == AnimationPath::Rotation {
                let sampler = &animation.samplers[channel.sampler];
                let job = &mut jobs[mapping[sampler.output]];
                if sampler.interpolation == AnimationInterpolation::CubicSpline {
                    job.rotation_cubic_values = true;
                } else {
                    job.rotation_all = true;
                }
            }
        }
    }
    let mut pending = BinaryHeap::with_capacity(jobs.len());
    for (index, job) in jobs.iter().enumerate() {
        pending.push(Reverse((
            structure.accessors[job.accessor].range.offset,
            index,
            0_u64,
        )));
    }
    // Allocated only after the work limit has passed; no BIN-sized allocation.
    let mut window = BinaryWindow::new(reader);
    while let Some(Reverse((offset, index, element))) = pending.pop() {
        let job = &mut jobs[index];
        let accessor = &structure.accessors[job.accessor];
        let bytes = window.element(offset, accessor.element_bytes as usize)?;
        inspect_element(job, accessor, bytes, element)?;
        let next = element + 1;
        if next < accessor.count {
            let next_offset = accessor
                .range
                .offset
                .checked_add(next.checked_mul(accessor.stride).ok_or_else(limit)?)
                .ok_or_else(limit)?;
            pending.push(Reverse((next_offset, index, next)));
        }
    }
    for (index, accessor) in structure.accessors.iter().enumerate() {
        let job = &jobs[mapping[index]];
        for (declared, actual, label) in [
            (&accessor.min, &job.min, "min"),
            (&accessor.max, &job.max, "max"),
        ] {
            if let Some(declared) = declared {
                for (component, &bound) in declared.iter().enumerate() {
                    let bound = component_precision(bound, accessor.component_type);
                    if bound != actual[component] {
                        return Err(invalid(format!(
                            "accessor {index} {label}[{component}] disagrees with actual component extrema"
                        )));
                    }
                }
            }
        }
    }
    Ok(NumericFacts {
        unique_layouts: jobs.len(),
        elements,
        components,
    })
}

fn inspect_element(
    job: &mut Job,
    accessor: &ModelAccessor,
    bytes: &[u8],
    element: u64,
) -> Result<()> {
    let (columns, rows) = accessor.shape.dimensions();
    let width = match accessor.component_type {
        5120 | 5121 => 1,
        5122 | 5123 => 2,
        5125 | 5126 => 4,
        _ => return Err(invalid("unsupported component in checked structure")),
    };
    let column_bytes = if columns > 1 {
        (rows as usize * width).div_ceil(4) * 4
    } else {
        rows as usize * width
    };
    let mut values = [0_f64; 16];
    for column in 0..columns as usize {
        for row in 0..rows as usize {
            let component = column * rows as usize + row;
            let offset = column * column_bytes + row * width;
            let data = &bytes[offset..offset + width];
            let value = match accessor.component_type {
                5120 => f64::from(data[0] as i8),
                5121 => f64::from(data[0]),
                5122 => f64::from(i16::from_le_bytes([data[0], data[1]])),
                5123 => f64::from(u16::from_le_bytes([data[0], data[1]])),
                5125 => f64::from(u32::from_le_bytes([data[0], data[1], data[2], data[3]])),
                5126 => f64::from(f32::from_le_bytes([data[0], data[1], data[2], data[3]])),
                _ => unreachable!("component checked above"),
            };
            if !value.is_finite() {
                return Err(invalid(format!(
                    "accessor {} contains NaN or infinity",
                    job.accessor
                )));
            }
            values[component] = value;
            job.min[component] = job.min[component].min(value);
            job.max[component] = job.max[component].max(value);
        }
    }
    if job.timestamps {
        if values[0] < 0.
            || job
                .previous_time
                .is_some_and(|previous| values[0] <= previous)
        {
            return Err(invalid(format!(
                "accessor {} animation timestamps must be nonnegative and strictly increasing",
                job.accessor
            )));
        }
        job.previous_time = Some(values[0]);
    }
    if job.rotation_all || (job.rotation_cubic_values && element % 3 == 1) {
        let squared_length = values[..4].iter().map(|value| value * value).sum::<f64>();
        if (squared_length - 1.).abs() > UNIT_LENGTH_SQUARED_TOLERANCE {
            return Err(invalid(format!(
                "accessor {} animation rotation value must be a unit quaternion",
                job.accessor
            )));
        }
    }
    if let Some(vertex_count) = job.index_bound {
        let reserved = match accessor.component_type {
            5121 => u32::from(u8::MAX),
            5123 => u32::from(u16::MAX),
            5125 => u32::MAX,
            _ => {
                return Err(invalid(
                    "index component in checked structure is not unsigned",
                ))
            }
        };
        if values[0] >= vertex_count as f64 || values[0] == f64::from(reserved) {
            return Err(invalid(format!(
                "accessor {} contains an out-of-range or reserved index",
                job.accessor
            )));
        }
    }
    if job.normal || job.tangent {
        let squared_length = values[..3].iter().map(|value| value * value).sum::<f64>();
        if (squared_length - 1.).abs() > UNIT_LENGTH_SQUARED_TOLERANCE {
            return Err(invalid(format!(
                "accessor {} contains a non-unit normal/tangent",
                job.accessor
            )));
        }
    }
    if job.tangent && values[3].abs() != 1. {
        return Err(invalid(format!(
            "accessor {} tangent handedness must be -1 or +1",
            job.accessor
        )));
    }
    if job.color_zero && accessor.component_type == 5126 {
        let count = (columns * rows) as usize;
        if values[..count]
            .iter()
            .any(|value| !(0. ..=1.).contains(value))
        {
            return Err(invalid(format!(
                "accessor {} COLOR_0 component is outside [0,1]",
                job.accessor
            )));
        }
    }
    Ok(())
}

struct BinaryWindow<'a, R> {
    reader: &'a mut ContainerReader<R>,
    buffer: Box<[u8; WINDOW_BYTES]>,
    start: u64,
    filled: usize,
    end: u64,
}
impl<'a, R: Read> BinaryWindow<'a, R> {
    fn new(reader: &'a mut ContainerReader<R>) -> Self {
        let start = reader.offset();
        let end = start + reader.remaining();
        Self {
            reader,
            buffer: Box::new([0; WINDOW_BYTES]),
            start,
            filled: 0,
            end,
        }
    }
    fn element(&mut self, offset: u64, size: usize) -> Result<&[u8]> {
        let end = offset.checked_add(size as u64).ok_or_else(limit)?;
        if offset < self.start || end > self.end || size > 64 {
            return Err(invalid("numeric element exceeds the checked BIN stream"));
        }
        if end > self.start + self.filled as u64 {
            let loaded_end = self.start + self.filled as u64;
            if offset < loaded_end {
                let keep = (loaded_end - offset) as usize;
                self.buffer.copy_within(self.filled - keep..self.filled, 0);
                self.start = offset;
                self.filled = keep;
            } else {
                self.reader
                    .skip(offset - loaded_end)
                    .map_err(|error| invalid(error.message))?;
                self.start = offset;
                self.filled = 0;
            }
            let count = self
                .reader
                .remaining()
                .min((WINDOW_BYTES - self.filled) as u64) as usize;
            self.reader
                .read_into(&mut self.buffer[self.filled..self.filled + count])
                .map_err(|error| invalid(error.message))?;
            self.filled += count;
            if size > self.filled {
                return Err(invalid("short BIN numeric element"));
            }
        }
        let local = (offset - self.start) as usize;
        Ok(&self.buffer[local..local + size])
    }
}
